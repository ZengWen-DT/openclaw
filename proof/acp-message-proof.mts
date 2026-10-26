import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AcpGatewayAgent } from "./src/acp/translator.js";
import { createSqliteAcpEventLedger } from "./src/acp/event-ledger.js";
import { closeOpenClawStateDatabaseAsync } from "./src/state/openclaw-state-db.js";
import type { GatewayClient } from "./src/gateway/client.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-boundary-proof-"));
const ledger = createSqliteAcpEventLedger({ path: path.join(root, "state.sqlite") });
const reports: Array<Record<string, unknown>> = [];
const errors: string[] = [];
const blocks = [{ type: "text", text: "Repeat this prompt." }, { type: "text", text: "Second block." }] as const;
const text = (value: string): SessionUpdate => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text: value } });

async function observe(name: string, transcript: unknown[], complete: boolean) {
  const session = { sessionId: name, sessionKey: name, cwd: root };
  await ledger.startSession({ ...session, complete });
  if (name === "legacy-ledger") {
    for (const runId of ["failed-run", "retry-run"]) {
      for (const block of blocks) await ledger.recordUpdate({ ...session, runId, update: text(block.text) });
    }
    await ledger.recordUpdate({ ...session, runId: "retry-run", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer." } } });
    await ledger.recordUpdate({ ...session, runId: "explicit-run", update: { sessionUpdate: "agent_message_chunk", messageId: "already-explicit", content: { type: "text", text: "Explicit answer." } } });
    await ledger.recordUpdate({ ...session, update: { sessionUpdate: "current_mode_update", currentModeId: "high" } });
  }
  if (name === "recorded-prompts") {
    for (const runId of ["failed-run", "retry-run"]) await ledger.recordUserPrompt({ ...session, runId, prompt: [...blocks] });
  }
  const before = complete ? await ledger.readReplay(session) : undefined;
  const gatewayCalls: string[] = [];
  const gateway = {
    request: async (method: string) => {
      gatewayCalls.push(method);
      if (method === "sessions.list") return { sessions: [] };
      if (method === "sessions.get") return { messages: transcript };
      throw new Error(`Unexpected Gateway fixture request: ${method}`);
    },
  } as unknown as GatewayClient;
  const c2a = new PassThrough();
  const a2c = new PassThrough();
  const wire: string[] = [];
  a2c.on("data", (bytes: Buffer) => wire.push(bytes.toString("utf8")));
  let agent!: AcpGatewayAgent;
  const agentConnection = new AgentSideConnection((connection) => {
    agent = new AcpGatewayAgent(connection, gateway, { eventLedger: ledger });
    return agent;
  }, ndJsonStream(Writable.toWeb(a2c), Readable.toWeb(c2a)));
  const updates: SessionNotification[] = [];
  const client = new ClientSideConnection(() => ({
    sessionUpdate: (notification: SessionNotification) => { updates.push(structuredClone(notification)); },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  }), ndJsonStream(Writable.toWeb(c2a), Readable.toWeb(a2c)));
  void agentConnection.closed.catch(() => {});
  void client.closed.catch(() => {});
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "boundary-proof", version: "1" } });
    const loads: SessionUpdate[][] = [];
    for (let index = 0; index < 2; index++) {
      updates.length = 0;
      await client.loadSession({ sessionId: name, cwd: root, mcpServers: [] });
      await setImmediate();
      loads.push(updates.map((notification) => notification.update));
    }
    const users = loads[0].filter((update) => update.sessionUpdate === "user_message_chunk");
    const ids = users.map((update) => update.messageId ?? null);
    const repeatedIds = loads[1].filter((update) => update.sessionUpdate === "user_message_chunk").map((update) => update.messageId ?? null);
    const grouped: string[] = [];
    let previousId: unknown = Symbol("none");
    for (const update of users) {
      const id = update.messageId ?? null;
      const content = update.content.type === "text" ? update.content.text : "";
      if (id === previousId) grouped[grouped.length - 1] += content;
      else grouped.push(content);
      previousId = id;
    }
    const after = complete ? await ledger.readReplay(session) : undefined;
    const checks = {
      fourChunks: users.length === 4,
      allHaveIds: ids.every((id) => typeof id === "string" && id.length > 0),
      sameMessageSharesId: ids[0] === ids[1] && ids[2] === ids[3],
      distinctPrompts: ids[0] !== ids[2],
      clientSeesTwoMessages: grouped.length === 2,
      stableAcrossReload: JSON.stringify(ids) === JSON.stringify(repeatedIds),
      ledgerUnchanged: JSON.stringify(before) === JSON.stringify(after),
      replayPath: complete ? !gatewayCalls.includes("sessions.get") : gatewayCalls.includes("sessions.get"),
      ...(name === "legacy-ledger" ? {
        explicitIdPreserved: loads[0].some((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Explicit answer." && update.messageId === "already-explicit"),
        roleSeparation: loads[0].some((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Answer." && typeof update.messageId === "string" && update.messageId !== ids[2]),
        nonContentPreserved: loads[0].some((update) => update.sessionUpdate === "current_mode_update" && update.currentModeId === "high"),
      } : {}),
    };
    reports.push({ scenario: name, ids, repeatedIds, clientMessageCount: grouped.length, checks, gatewayCalls, updates: loads[0] });
    console.log(JSON.stringify({ scenario: name, ids, clientMessageCount: grouped.length, checks }));
    console.log(`WIRE ${name} ${wire.join("")}`);
    for (const [check, passed] of Object.entries(checks)) if (!passed) errors.push(`${name}: ${check}`);
  } finally {
    await agent.shutdown();
    c2a.destroy();
    a2c.destroy();
  }
}

try {
  for (const missingIds of [false, true]) {
    await observe(missingIds ? "transcript-no-entry-ids" : "transcript-entry-ids", [
      { role: "user", content: [...blocks], __openclaw: missingIds ? { seq: 10 } : { id: "failed-prompt", seq: 10 } },
      { role: "custom", customType: "run-failed-before-reply", content: "Provider rejected the request." },
      { role: "assistant", content: [] },
      { role: "user", content: [...blocks], __openclaw: missingIds ? { seq: 13 } : { id: "retry-prompt", seq: 13 } },
    ], false);
  }
  await observe("legacy-ledger", [], true);
  await observe("recorded-prompts", [], true);
  await fs.writeFile("acp-proof.json", JSON.stringify({ sourceSha: process.env.TARGET_SHA, scope: "real ACP SDK NDJSON and production translator/SQLite ledger; Gateway responses are fixtures; no live Gateway/model/client UI", reports, failures: errors }, null, 2));
  if (errors.length) {
    console.error(`BEHAVIOR_ASSERTION_FAILURES ${JSON.stringify(errors)}`);
    process.exitCode = 2;
  } else {
    assert.equal(reports.length, 4);
    console.log("ACP_BOUNDARY_PROOF_PASS");
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(root, { recursive: true, force: true });
}
