# Browser Talk model-scoped CLI routing proof

Related: https://github.com/openclaw/openclaw/issues/161885

Candidate: `d9071846f4711756e3b6bbaff8582a525c8d22b4`
Source tree: `ba0e635dd9c1080fb6a1b57e601122f78e4c34b8`
Baseline: `de14009aa2226f27188fd599472fbec7014847b3`

## What ran

An isolated real Gateway accepts public `talk.client.create` and invokes the actual host-injected native consultation callback. A registered synthetic Talk provider supplies only a nonfunctional media offer. Model execution uses a deterministic local Claude JSONL executable and an HTTP loopback provider. The host admission, runtime selection, CLI protocol, fallback owner, session history and completion/cancellation lifecycle remain real. No private provider capability is forged, no real microphone/media connection is made, and no commercial model/carrier account or API key is used.

`results.json` is a sanitized derivation of observed results, not a raw transcript. No runtime grants, full CLI argv, host paths or real credentials are published. Generated raw result JSON and logs contain local paths and synthetic runtime data; do not publish them unchanged.

The candidate was tested as the exact staged source tree on the pinned baseline. The Git API commit was created afterward and independently verified to have the identical full tree and all ten changed blobs. Git metadata/build-ID changes were not rerun. This is source-Gateway proof, not an installed-package or device proof.

## Reproduce

Use Linux, Node 24.19.0, pnpm 12.5.1, frozen dependencies and a disposable directory without real OpenClaw accounts. Run each checkout separately; do not share node_modules or generated artifacts between active jobs. The fixtures clear inherited environment variables, create private synthetic homes, disable update/telemetry/catalog/background services, and bind loopback ports. They create files only in their own temporary home and the adjacent output directory below. Final fixtures terminate only CLI children whose recorded PID and command path match their own executable.

Keep this proof directory outside the checkout so the baseline can use the same files. Set `PROOF` to its absolute location. From the appropriate checkout root:

```sh
pnpm install --frozen-lockfile
mkdir -p ../issue161885-evidence
# Full canonical build, only supported tsdown concurrency is bounded.
GOMEMLIMIT=2GiB GOMAXPROCS=2 GOGC=30 NODE_OPTIONS=--max-old-space-size=6144 \
  node --import ./scripts/tsx.mjs "$PROOF/build-verify.mjs"
```

Original baseline observations used these exact scripts:

```sh
node --import ./scripts/tsx.mjs "$PROOF/gateway-repro.mts"
node --import ./scripts/tsx.mjs "$PROOF/gateway-authority-fallback.mts"
```

The first original fixture does not explicitly terminate idle CLI children and may take approximately ten minutes to exit after Gateway close. Its later authority/control fixture includes exact-owned-child cleanup. Do not interpret early Gateway close as host-command completion. Each writes output under `../issue161885-evidence`; preserve results before the next run because original filenames overlap. The baseline Talk CLI cases fail before CLI invocation and never request fallback; ordinary agent CLI and CLI-to-loopback fallback controls succeed.

Candidate observations used these exact scripts:

```sh
node --import ./scripts/tsx.mjs "$PROOF/gateway-final-readonly-routing.mts"
node --import ./scripts/tsx.mjs "$PROOF/gateway-final-loader-controls.mts"
```

Both candidate commands exited 0 (101.064s and 98.033s). The readonly fixture records outcomes, so inspect its result JSON: all three Talk cases must return answers, including CLI429-to-loopback fallback; exit 0 alone is not the routing assertion. Its ordinary writer-scoped agent controls must also succeed. The control fixture asserts two successful claims per route, cancellation/no successor request at the fallback boundary, CLI steering/cancel/replacement, and direct upstream closure. Separate inspection of its recorded Gateway lifecycle events found one terminal event for each of ten runs: seven successful and three cancelled. That terminal count is an inspected observation, not an assertion inside the fixture.

The scripts' retained `head` JSON field identifies the pinned baseline, not the final API commit. Use the source-tree and manifest identities above to bind candidate evidence.

## Regression and gates

```sh
pnpm test src/agents/embedded-agent-runner/runs.test.ts \
  src/agents/embedded-agent-runner/runs.generation.test.ts \
  src/gateway/talk/client-agent-consult.routing.test.ts \
  src/gateway/talk/client-gateway-control.agent-consult.test.ts \
  src/gateway/talk/client-gateway-control.agent-consult.retry-context.test.ts \
  extensions/openai/realtime-quicksilver-delegation.test.ts --maxWorkers=1
```

106 passed in 66.036 seconds. Four routing regressions failed against the original browser entry; two replacement tests failed against the original GPT-Live controller. Final full build, core production types, both affected canonical test-type graphs, changed-file type-aware lint/format, line/assertion ratchets, dead-code and import-cycle checks passed.

Full OpenAI lane: 1,251 passed, 5 failed, 1 skipped across 91 files. The same five failures were reproduced on clean baseline: two embedding-batch timeout/stream-bound cases, missing ICE candidate offer, and two RTP direct-sink variants. Global extension typing hit memory exit 137; no complete aggregate check/full-CI pass is claimed. Repository autoreview had no confirmed final outcome; independent review of the exact final patch found no remaining actionable P0–P2.

## Limits

Browser Talk only; plugin meeting/voice-call/FaceTime consultation paths remain unchanged. Human sentinel retention is observed for CLI/fallback; direct embedded loses it on both original and candidate, and this fix does not address that inherited behavior. No live speech, commercial-provider, working media, device, installed updater, release or deployment claim.
