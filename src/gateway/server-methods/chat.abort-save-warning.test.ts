// Preserve registry mocks before the cancellation entrypoints load.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { enqueueSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as sessionLifecycle from "../session-lifecycle-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import * as abortHandler from "./chat-abort-handler.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import {
  createAbortTestRunState,
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();

it("preserves an earlier structured abort refusal when terminal cleanup also fails", async () => {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:cleanup-refusal",
    sessionId: "cleanup-refusal-session",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  const handle = createEmbeddedRunHandle({ runId: "embedded-cleanup" });
  setActiveEmbeddedRun(scope.sessionId, handle, scope.sessionKey);
  const refused = { code: "FORBIDDEN", message: "Stop was refused", details: { reason: "owner" } };
  const persist = vi
    .spyOn(sessionLifecycle, "persistGatewaySessionLifecycleEvent")
    .mockRejectedValueOnce(new Error("secondary terminal failure"));
  const abort = vi
    .spyOn(abortHandler, "handleChatAbortRequestWithLifecycle")
    .mockImplementationOnce(async (options, lifecycle) => {
      lifecycle?.onAuthorizedAfterQueuedAbort?.();
      options.respond(false, undefined, refused);
    });
  try {
    const respond = await invokeChatAbortHandler({
      handler: (options) =>
        sessionAbortHandlers["sessions.abort"]({ ...options, params: { key: scope.sessionKey } }),
      context: createChatAbortContext({ getRuntimeConfig }),
      request: { sessionKey: scope.sessionKey },
      client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.lastCall?.[0]).toBe(false);
    expect(respond.mock.lastCall?.[2]).toEqual(refused);
  } finally {
    abort.mockRestore();
    persist.mockRestore();
    clearActiveEmbeddedRun(scope.sessionId, handle, scope.sessionKey);
  }
});

it.each(["run", "session", "stop", "sessions", "queued", "terminal", "revoked"] as const)(
  "reports the failed SQLite append through %s cancellation",
  async (route) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subagent:save-warning",
      sessionId: "save-warning-session",
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    openOpenClawAgentDatabase(scope).db.exec(
      "CREATE TRIGGER reject_abort_reply BEFORE INSERT ON transcript_events " +
        "WHEN json_extract(NEW.event_json, '$.message.openclawAbort.runId') = 'run-save-failure' " +
        "BEGIN SELECT RAISE(ABORT, 'fixture transcript write failed'); END",
    );
    const runId = "run-save-failure";
    const active = createActiveRun(scope.sessionKey, scope);
    const terminalFailure = route === "terminal" || route === "revoked";
    if (terminalFailure) {
      const error =
        route === "revoked"
          ? new SessionMutationAuthorizationChangedError({
              code: "FORBIDDEN",
              message: "terminal authority changed",
              details: { reason: "fixture-revocation" },
            })
          : new Error("terminal write failed");
      active.projectSessionTerminalPersistence = Promise.reject(error);
      void active.projectSessionTerminalPersistence.catch(() => {});
    }
    if (route === "queued") {
      enqueueSwarmRun({
        groupId: "save-warning",
        runId: "queued-save-warning",
        start: vi.fn(async () => {}),
        activeRunIds: ["occupied-slot"],
        maxConcurrent: 1,
        onStartFailure: () => true,
      });
      registerSubagentRun({
        runId: "queued-save-warning",
        childSessionKey: scope.sessionKey,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "queued collector",
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
      await settleSubagentRegistryPersistenceWork();
    }
    const respond = vi.fn();
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
      chatAbortControllers: new Map([[runId, active]]),
      chatRunState: createAbortTestRunState([[runId, { buffer: "Already streamed reply" }]]),
    });
    const pending = invokeChatAbortHandler({
      handler:
        route === "stop"
          ? (options) =>
              handleDirectExternalChatSend({
                ...options,
                params: {
                  sessionKey: scope.sessionKey,
                  message: "/stop",
                  idempotencyKey: "stop-warning",
                },
              })
          : route === "sessions" || route === "queued" || terminalFailure
            ? (options) =>
                sessionAbortHandlers["sessions.abort"]({
                  ...options,
                  params: { key: scope.sessionKey, ...(route === "queued" ? {} : { runId }) },
                })
            : handleChatAbortRequest,
      context,
      client: { connId: "save-warning-owner", connect: { scopes: ["operator.admin"] } },
      request: { sessionKey: scope.sessionKey, ...(route === "run" ? { runId } : {}) },
      respond,
    });
    if (terminalFailure) {
      await expect(pending).rejects.toThrow(/terminal.*could not be saved to history/);
      if (route === "revoked") {
        await expect(pending).rejects.toMatchObject({
          error: { code: "FORBIDDEN", details: { reason: "fixture-revocation" } },
        });
      }
    } else {
      await pending;
      expect(respond.mock.lastCall?.[2]).toBeUndefined();
      expect(respond.mock.lastCall?.[0]).toBe(true);
      expect(respond.mock.lastCall?.[1]).toMatchObject({
        warning: expect.stringContaining("could not be saved to history"),
      });
    }
    expect(active.controller.signal.aborted).toBe(true);
    expect(await loadTranscriptEvents(scope)).not.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ idempotencyKey: "run-save-failure:assistant" }),
      }),
    );
  },
);
