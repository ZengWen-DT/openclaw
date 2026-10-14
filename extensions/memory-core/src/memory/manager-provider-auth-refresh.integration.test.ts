import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { MemoryIndexManager } from "./manager.js";

it("reuses the manager after shared and agent-scoped OpenAI OAuth credentials change", async () => {
  // Real auth persistence/publication, provider resolution, HTTP, indexing and retrieval.
  // Synthetic OAuth profiles exercise client lifetime, not live account eligibility.
  const state = await createOpenClawTestState({
    label: "memory-embedding-auth-refresh",
    env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined, CODEX_HOME: "" },
  });
  const port = await acquireTestPortBlock({ offsets: [0] });
  const requests: Array<{ authorization?: string; input: string[] }> = [];
  let acceptedBearer = "Bearer fixture-before-login";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        input: string[];
      };
      requests.push({ authorization: request.headers.authorization, input });
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== acceptedBearer) {
        response.writeHead(401).end(JSON.stringify({ error: { code: "token_expired" } }));
        return;
      }
      response.end(
        JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }),
      );
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let manager: MemoryIndexManager | null = null;
  const provider = "openai";
  const profileId = `${provider}:default`;
  const publishBearer = async (token: string, agentDir?: string) => {
    await expect(
      updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater(store) {
          store.profiles[profileId] = {
            type: "oauth",
            provider,
            access: token,
            refresh: `fixture-refresh-${token}`,
            expires: Date.now() + 3_600_000,
          };
          return true;
        },
      }),
    ).resolves.not.toBeNull();
  };
  try {
    server.listen(port.port, "127.0.0.1");
    await once(server, "listening");
    await configureMemoryCoreDreamingStateForTests(state.env);
    const cfg: OpenClawConfig = {
      plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      auth: {
        profiles: { [profileId]: { provider, mode: "oauth" } },
        order: { [provider]: [profileId] },
      },
      agents: {
        defaults: { workspace: state.workspaceDir },
        entries: { main: {}, research: { workspace: state.workspaceDir } },
      },
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${port.port}/v1`,
            models: [],
          },
        },
      },
      memory: {
        search: {
          provider,
          model: "fixture-model",
          fallback: "none",
          sources: ["memory"],
          rememberAcrossConversations: false,
          query: { minScore: 0 },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const note = path.join(state.workspaceDir, "MEMORY.md");
    await fs.writeFile(note, "Amber beacon before login.");
    await publishBearer("fixture-before-login");
    manager = await MemoryIndexManager.get({
      cfg,
      agentId: "research",
      runInBackgroundContext: runInMemoryTestBackgroundContext,
    });
    expect(manager).not.toBeNull();
    if (!manager) {
      throw new Error("expected a retained memory manager");
    }
    await manager.sync({ reason: "initial" });
    await expect(manager.search("semantic query")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ snippet: "Amber beacon before login." })]),
    );
    acceptedBearer = "Bearer fixture-after-login";
    await expect(manager.search("expired query")).rejects.toThrow("401");

    for (const [token, agentDir, content] of [
      ["fixture-after-login", undefined, "Cobalt beacon after shared login."],
      ["fixture-agent-login", state.agentDir("research"), "Violet beacon after agent login."],
    ] as const) {
      acceptedBearer = `Bearer ${token}`;
      await publishBearer(token, agentDir);
      await fs.writeFile(note, content);
      const firstFreshRequest = requests.length;
      // sync joins an admitted pass. Drain it before forcing this file generation.
      await manager.sync({ reason: "auth-refresh-drain" });
      await manager.sync({ reason: "auth-refreshed", force: true });
      await expect(manager.search("semantic query")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ snippet: content })]),
      );
      const freshRequests = requests.slice(firstFreshRequest);
      expect(freshRequests.length).toBeGreaterThanOrEqual(2);
      expect(freshRequests.every((request) => request.authorization === acceptedBearer)).toBe(true);
      expect(
        freshRequests.some((request) => request.input.some((text) => text.includes(content))),
      ).toBe(true);
    }
  } finally {
    await manager?.close();
    clearRuntimeAuthProfileStoreSnapshots();
    resetMemoryCoreDreamingStateForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await port.release();
    await state.cleanup();
  }
});
