import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveMediaBuffer } from "../media/store.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptReaders from "./session-transcript-readers.js";

const auth = {
  mode: "trusted-proxy" as const,
  allowTailscale: false,
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowLoopback: true,
  },
};
const sessionKey = "agent:main:dashboard:saved-attachment";
const messageId = "saved-message";
const scope = { agentId: "main", sessionKey, sessionId: "saved-attachment-session" };

type Fixture = {
  cfg: OpenClawConfig;
  source: string;
  path: string;
  text: string;
  readerId: string;
  request: (options?: {
    meta?: boolean;
    ticket?: string;
    source?: string;
    messageId?: string;
    sessionKey?: string;
    method?: string;
    scopes?: string;
    range?: string;
  }) => Promise<Response>;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: {
          auth,
          trustedProxies: ["127.0.0.1"],
          roles: {
            default: "guest",
            definitions: {
              revoked: { sessions: { others: "view" }, agents: "*", scopes: [] },
              guest: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.sessions.read"],
              },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      const owner = await ensureCanonicalUserProfileForEmail("attachment-owner@example.test");
      const reader = await ensureCanonicalUserProfileForEmail("attachment-reader@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const text = "Saved selection comment\n";
      const saved = await saveMediaBuffer(
        Buffer.from(text),
        "text/plain",
        "inbound",
        undefined,
        "selection.txt",
      );
      const source = `media://inbound/${saved.id}`;
      await appendTranscriptMessage(scope, {
        eventId: messageId,
        message: {
          role: "user",
          content: "Review this selection",
          __openclaw: {
            media: [{ url: source, contentType: "text/plain", fileName: "selection.txt" }],
          },
        },
      });
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      bindSessionRowProjection(context, () => projection);
      const listener = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createGatewayHttpServer({
            clients: new Set(),
            controlUiEnabled: true,
            controlUiBasePath: "",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            resolvedAuth: auth,
            getResolvedAuth: () => auth,
            getRuntimeConfig: () => cfg,
            getGatewayRequestContext: () => context,
            httpRequestLifetime: context,
            isTerminalEnabled: () => false,
          }),
      });
      const route = `http://127.0.0.1:${listener.claim.port}/__openclaw__/assistant-media`;
      const headers = {
        "x-forwarded-for": "198.51.100.23",
        "x-forwarded-user": "attachment-reader@example.test",
        "x-forwarded-proto": "https",
        "x-openclaw-scopes": "operator.sessions.read",
      };
      const request: Fixture["request"] = async (options = {}) => {
        const params = new URLSearchParams({
          source: options.source ?? source,
          sessionKey: options.sessionKey ?? sessionKey,
          agentId: "main",
          messageId: options.messageId ?? messageId,
        });
        if (options.meta !== false) {
          params.set("meta", "1");
        }
        if (options.ticket) {
          params.set("mediaTicket", options.ticket);
        }
        return await fetch(`${route}?${params}`, {
          method: options.method ?? "GET",
          headers: {
            ...(options.ticket && options.meta === false ? {} : headers),
            ...(options.range ? { Range: options.range } : {}),
            ...(options.scopes ? { "x-openclaw-scopes": options.scopes } : {}),
          },
        });
      };
      try {
        await run({ cfg, source, path: saved.path, text, readerId: reader.id, request });
      } finally {
        vi.restoreAllMocks();
        listener.listener.closeAllConnections();
        await listener.releaseListener();
        await listener.claim.release();
        projection.dispose();
      }
    },
  );
}

async function ticket(fixture: Fixture) {
  const response = await fixture.request();
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const metadata = JSON.parse(body);
  expect(metadata).toMatchObject({ available: true, mediaTicket: expect.any(String) });
  return metadata.mediaTicket as string;
}

afterEach(() => vi.restoreAllMocks());

describe("saved message attachment HTTP authorization", () => {
  it("admits a cold persisted guest attachment, content, HEAD, ranges and ticket refresh", async () => {
    await withFixture(async (fixture) => {
      const mediaTicket = await ticket(fixture);
      const content = await fixture.request({ meta: false, ticket: mediaTicket });
      expect(content.status).toBe(200);
      expect(await content.text()).toBe(fixture.text);
      const head = await fixture.request({ meta: false, ticket: mediaTicket, method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(fixture.text)));
      expect(await head.text()).toBe("");
      const range = await fixture.request({ meta: false, ticket: mediaTicket, range: "bytes=0-4" });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("Saved");
      const refreshed = await fixture.request({ ticket: mediaTicket });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        available: true,
        mediaTicket: expect.any(String),
      });
    });
  });

  it("does not turn a readable session or a signed ticket into arbitrary file access", async () => {
    await withFixture(async (fixture) => {
      const mediaTicket = await ticket(fixture);
      expect((await fixture.request({ messageId: "" })).status).toBe(403);
      expect((await fixture.request({ messageId: "unrelated-message" })).status).toBe(404);
      expect((await fixture.request({ source: fixture.path })).status).toBe(403);
      const unrelated = await saveMediaBuffer(
        Buffer.from("Unrelated secret"),
        "text/plain",
        "inbound",
      );
      expect((await fixture.request({ source: `media://inbound/${unrelated.id}` })).status).toBe(
        404,
      );
      expect(
        (
          await fixture.request({
            meta: false,
            ticket: mediaTicket,
            messageId: "unrelated-message",
          })
        ).status,
      ).toBe(404);
      expect(
        (await fixture.request({ meta: false, ticket: mediaTicket, messageId: "" })).status,
      ).toBe(404);
    });
  });

  it("does not grant saved authority to a durable row colliding with a pending-input ID", async () => {
    await withFixture(async (fixture) => {
      const pendingId = `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}reserved-row`;
      await appendTranscriptMessage(scope, {
        eventId: pendingId,
        message: {
          role: "user",
          content: "Colliding row",
          __openclaw: { media: [{ url: fixture.source }] },
        },
      });
      expect((await fixture.request({ messageId: pendingId })).status).toBe(404);
    });
  });

  it("does not grant an attachment from an internal-effects session hidden from chat history", async () => {
    await withFixture(async (fixture) => {
      const hidden = {
        agentId: "main",
        ...resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-attachment" }),
      };
      await upsertSessionEntryCore(hidden, {
        sessionId: hidden.sessionId,
        updatedAt: 1,
        visibility: "shared",
      });
      await appendTranscriptMessage(hidden, {
        eventId: messageId,
        message: {
          role: "user",
          content: "Suppressed run",
          __openclaw: { media: [{ url: fixture.source }] },
        },
      });
      expect((await fixture.request({ sessionKey: hidden.sessionKey })).status).toBe(404);
    });
  });

  it("keeps established broad reads available when a locator has no saved association", async () => {
    await withFixture(async (fixture) => {
      delete fixture.cfg.gateway!.roles;
      setRuntimeConfigSnapshot(fixture.cfg, fixture.cfg);
      const response = await fixture.request({
        messageId: "unrelated-message",
        scopes: "operator.read",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true });
    });
  });

  it("rejects an attachment whose parent is hidden by normal chat display projection", async () => {
    await withFixture(async (fixture) => {
      await replaceTranscriptEvents(scope, [
        {
          type: "message",
          id: messageId,
          message: {
            role: "assistant",
            content: "Hidden mirror",
            openclawMessageToolMirror: {},
            __openclaw: { media: [{ url: fixture.source }] },
          },
        },
      ]);
      expect((await fixture.request()).status).toBe(404);
    });
  });

  it.each([true, false])(
    "rejects a foreign draft when named roles are configured: %s",
    async (roles) => {
      await withFixture(async (fixture) => {
        if (!roles) {
          delete fixture.cfg.gateway!.roles;
          setRuntimeConfigSnapshot(fixture.cfg, fixture.cfg);
        }
        await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
        expect((await fixture.request()).status).toBe(404);
      });
    },
  );

  it("revokes existing content tickets and refresh after the reader loses its scope", async () => {
    await withFixture(async (fixture) => {
      const mediaTicket = await ticket(fixture);
      await setCanonicalUserProfileRole(fixture.readerId, "revoked", {
        onCommitted: invalidateOperatorRolePolicy,
      });
      expect((await fixture.request({ meta: false, ticket: mediaTicket })).status).toBe(404);
      expect((await fixture.request({ ticket: mediaTicket })).status).toBe(403);
    });
  });

  it.each(["association", "session"] as const)(
    "revokes a ticket after its %s changes",
    async (kind) => {
      await withFixture(async (fixture) => {
        const mediaTicket = await ticket(fixture);
        if (kind === "association") {
          await replaceTranscriptEvents(scope, [
            {
              type: "message",
              id: messageId,
              message: {
                role: "user",
                content: `This text mentions ${fixture.source} but attaches nothing`,
              },
            },
          ]);
        } else {
          await upsertSessionEntryCore(scope, {
            sessionId: "replacement-session",
            updatedAt: 2,
            visibility: "shared",
          });
        }
        expect((await fixture.request({ meta: false, ticket: mediaTicket })).status).toBe(404);
        expect((await fixture.request({ ticket: mediaTicket })).status).toBe(404);
      });
    },
  );

  it.each(["remove", "continue-writing"] as const)(
    "does not publish stale association authority when transcript reads race %s",
    async (mutation) => {
      await withFixture(async (fixture) => {
        const read = transcriptReaders.readSessionMessageByIdAsync;
        vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementation(
          async (...args) => {
            const result = await read(...args);
            if (mutation === "remove") {
              await replaceTranscriptEvents(scope, []);
            } else {
              await appendTranscriptMessage(scope, {
                eventId: `concurrent-${crypto.randomUUID()}`,
                message: { role: "user", content: "Concurrent edit" },
              });
            }
            return result;
          },
        );
        const response = await fixture.request();
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(fixture.text);
      });
    },
  );

  it.each(["metadata", "content"] as const)(
    "rechecks association after awaited %s file preparation",
    async (operation) => {
      await withFixture(async (fixture) => {
        const mediaTicket = await ticket(fixture);
        const open = fs.open;
        let revoked = false;
        vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const opened = await open(filePath, flags, mode);
          if (!revoked && filePath === fixture.path) {
            revoked = true;
            await replaceTranscriptEvents(scope, []);
          }
          return opened;
        });
        const response = await fixture.request({
          meta: operation === "metadata",
          ticket: mediaTicket,
        });
        expect(revoked).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(fixture.text);
      });
    },
  );
});
