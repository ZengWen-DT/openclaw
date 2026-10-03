import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated synthetic protocol proof. No hosted Buzz account or service is contacted.
const repo = path.resolve(process.argv[2] ?? '.');
const baseline = process.argv.includes('--expect-baseline');
const require = createRequire(path.join(repo, 'package.json'));
const { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } = require('nostr-tools');
const { WebSocketServer } = require('ws');
const load = (file: string) => import(pathToFileURL(path.join(repo, file)).href);
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'buzz-ancestry-proof-'));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_NO_AUTO_UPDATE = '1';
process.env.DO_NOT_TRACK = '1';
const botKey = generateSecretKey();
const senderKey = generateSecretKey();
const botPublicKey = getPublicKey(botKey);
const room = randomUUID();
const otherRoom = randomUUID();
const now = Math.floor(Date.now() / 1000);
const root = finalizeEvent({ kind: 9, created_at: now, content: 'synthetic root', tags: [['h', room]] }, senderKey);
const child = finalizeEvent({ kind: 9, created_at: now, content: 'synthetic child', tags: [['h', room], ['e', root.id, '', 'reply']] }, senderKey);
const known = new Map([[root.id, root], [child.id, child]]);
// Matches block/buzz 8af2d91f37270365d5cd9170ac48349baa08475e:
// crates/buzz-core/src/nip10.rs:29-42, handlers/ingest.rs:922-1007 and 1043-1057.
function ancestry(tags: string[][]): { root: string; parent: string } | undefined {
  let root: string | undefined;
  let reply: string | undefined;
  for (const tag of tags) {
    if (tag[0] !== 'e' || tag.length < 4 || !/^[a-f0-9]{64}$/i.test(tag[1])) continue;
    if (tag[3] === 'root') root = tag[1];
    if (tag[3] === 'reply') reply = tag[1];
  }
  return reply ? { root: root ?? reply, parent: reply } : undefined;
}
const wire: Array<Record<string, unknown>> = [];
const accepted: any[] = [];
let authenticated = 0;
const server = createServer();
const sockets = new WebSocketServer({ server });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const relayUrl = `ws://127.0.0.1:${address.port}/`;
const alias = (id: string) => id === root.id ? 'root' : id === child.id ? 'child' : id === room ? 'room-a' : id === otherRoom ? 'room-b' : id;
const sanitizedTags = (tags: string[][]) => tags.map(tag => tag.map((part, index) => index === 1 ? alias(part) : part));
sockets.on('connection', (socket: any) => {
  const challenge = randomUUID();
  let identity: string | undefined;
  const send = (frame: unknown[]) => socket.send(JSON.stringify(frame));
  send(['AUTH', challenge]);
  socket.on('message', (data: Buffer) => {
    const [kind, event] = JSON.parse(data.toString('utf8'));
    if (kind === 'AUTH') {
      const valid = verifyEvent(event) && event.kind === 22242 && event.pubkey === botPublicKey &&
        event.tags.some((tag: string[]) => tag[0] === 'relay' && tag[1] === relayUrl) &&
        event.tags.some((tag: string[]) => tag[0] === 'challenge' && tag[1] === challenge) &&
        Math.abs(event.created_at - Math.floor(Date.now() / 1000)) < 60;
      if (valid) { identity = event.pubkey; authenticated++; }
      send(['OK', event.id, valid, valid ? '' : 'invalid: authentication']);
      return;
    }
    if (kind !== 'EVENT') return;
    const signatureValid = verifyEvent(event);
    let error = !signatureValid || event.pubkey !== identity ? 'invalid: publisher' : '';
    const target = event.tags.find((tag: string[]) => tag[0] === 'h')?.[1];
    if (![room, otherRoom].includes(target)) error ||= 'restricted: not a member';
    const markers = ancestry(event.tags);
    // Validate against stored signed parent ancestry, independent of scenario expectations.
    if (markers) {
      const parent = known.get(markers.parent);
      if (!parent) error ||= 'invalid: reply parent not found';
      else if (parent.tags.find((tag: string[]) => tag[0] === 'h')?.[1] !== target) error ||= 'invalid: reply parent belongs to another channel';
      else if (markers.root !== (ancestry(parent.tags)?.root ?? parent.id)) error ||= 'invalid: root tag does not match thread ancestry';
    }
    const ok = error === '';
    wire.push({ scenario: event.content, authenticated: identity === botPublicKey, signatureValid,
      tags: sanitizedTags(event.tags), response: ['OK', '<signed-event-id>', ok, error] });
    if (ok) { accepted.push(event); known.set(event.id, event); }
    send(['OK', event.id, ok, error]);
  });
});
let resetRegistry: (() => void) | undefined;
try {
  const [{ buzzPlugin, setBuzzRuntime }, { runMessageAction }, { buildThreadingToolContext },
    { setActivePluginRegistry }, { createTestRegistry }, { createPluginRuntime }] = await Promise.all([
    load('extensions/buzz/api.ts'), load('src/infra/outbound/message-action-runner.ts'),
    load('src/auto-reply/reply/agent-runner-utils.ts'), load('src/plugins/runtime.ts'),
    load('src/test-utils/channel-plugins.ts'), load('src/plugins/runtime/index.ts'),
  ]);
  setBuzzRuntime(createPluginRuntime());
  setActivePluginRegistry(createTestRegistry([{ pluginId: 'buzz', plugin: buzzPlugin, source: 'isolated-proof', origin: 'bundled' }]));
  resetRegistry = () => setActivePluginRegistry(createTestRegistry([]));
  const cfg = {
    update: { checkOnStart: false }, telemetry: { enabled: false },
    models: { catalogRefresh: { enabled: false } },
    tools: { message: { crossContext: { allowWithinProvider: true, marker: { enabled: false } } } },
    channels: { buzz: { enabled: true, relayUrl, privateKey: Buffer.from(botKey).toString('hex'),
      groups: { [room]: { enabled: true }, [otherRoom]: { enabled: true } } } },
  };
  const cases = [
    { label: 'implicit-mid-thread', target: `buzz:${room}`, extra: {}, expected: [['h', 'room-a'], ['e', 'root', '', 'reply']], baselineError: 'root tag does not match thread ancestry' },
    { label: 'canonical-uppercase-room', target: room.toUpperCase(), extra: {}, expected: [['h', 'room-a'], ['e', 'root', '', 'reply']] },
    { label: 'different-room', target: `buzz:${otherRoom}`, extra: {}, expected: [['h', 'room-b']] },
    { label: 'explicit-child', target: `buzz:${room}`, extra: { replyTo: child.id }, expected: [['h', 'room-a'], ['e', 'root', '', 'root'], ['e', 'child', '', 'reply']], baselineError: 'root tag does not match thread ancestry' },
    { label: 'explicit-root', target: `buzz:${room}`, extra: { replyTo: root.id }, expected: [['h', 'room-a'], ['e', 'root', '', 'reply']] },
    { label: 'top-level', target: `buzz:${room}`, extra: { topLevel: true }, expected: [['h', 'room-a']] },
    { label: 'null-thread-opt-out', target: `buzz:${room}`, extra: { threadId: null }, expected: [['h', 'room-a']] },
    { label: 'root-trigger', target: `buzz:${room}`, extra: {}, sourceId: root.id, expected: [['h', 'room-a'], ['e', 'root', '', 'reply']] },
  ];
  const results = [];
  for (const scenario of cases) {
    const context = buildThreadingToolContext({ config: cfg, hasRepliedRef: { value: false }, sessionCtx: {
      Provider: 'buzz', OriginatingChannel: 'buzz', To: `buzz:${room}`, OriginatingTo: `buzz:${room}`,
      AccountId: 'default', ChatType: 'group', MessageSid: scenario.sourceId ?? child.id,
      MessageThreadId: scenario.sourceId ? scenario.sourceRoot : root.id, ReplyToMode: 'all',
    } });
    let error: string | undefined;
    let result: any;
    try {
      result = await runMessageAction({ cfg, action: 'send', actionOrigin: 'message-tool',
        params: { channel: 'buzz', target: scenario.target, message: scenario.label, ...scenario.extra }, toolContext: context });
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const observation = wire.find(entry => entry.scenario === scenario.label);
    assert.ok(observation, `${scenario.label}: did not reach authenticated relay`);
    assert.equal(observation.authenticated, true);
    assert.equal(observation.signatureValid, true);
    if (baseline && scenario.baselineError) {
      assert.match(error ?? '', new RegExp(scenario.baselineError));
      assert.equal((observation.response as unknown[])[2], false);
    } else if (!baseline) {
      assert.equal(error, undefined, `${scenario.label}: dispatch failed`);
      assert.equal((observation.response as unknown[])[2], true);
      assert.deepEqual(observation.tags, scenario.expected, `${scenario.label}: ancestry mismatch`);
    }
    results.push({ ...observation, resultKind: result?.kind ?? 'error', error: error ?? null,
      ambientThread: context.currentThreadTs ? alias(context.currentThreadTs) : null });
  }
  const source = await readFile(path.join(repo, 'extensions/buzz/src/channel.ts'));
  console.log(JSON.stringify({
    proof: 'synthetic authenticated NIP-42 WebSocket relay; no hosted Buzz service',
    entrypoint: 'buildThreadingToolContext -> runMessageAction -> Buzz outbound adapter -> sendBuzzTextOneShot -> signed relay publication',
    variant: baseline ? 'unmodified-main' : 'candidate', channelSha256: createHash('sha256').update(source).digest('hex'),
    generatedIdentitiesOnly: true, authenticatedConnections: authenticated, acceptedMessages: accepted.length, results,
  }, null, 2));
  console.log(baseline ? 'BUZZ_BASELINE_REJECTION_CONFIRMED' : 'BUZZ_SHARED_DISPATCH_RELAY_PROOF_GREEN');
} finally {
  resetRegistry?.();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const { closeOpenClawStateDatabaseAsync } = await load('src/plugin-sdk/sqlite-runtime-testing.ts');
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
