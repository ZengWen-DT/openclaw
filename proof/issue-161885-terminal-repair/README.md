# Browser Talk CLI routing and terminal-owner repair proof

Issue: https://github.com/openclaw/openclaw/issues/161885
PR: https://github.com/openclaw/openclaw/pull/164229

## Source and evidence boundaries

The source commit is `e7cfae3f6cb0aabe4633e82bac09c967ce8ec284`, tree `cee305578f2ee173f1136930713f86a9e20fdfb8`, with sole parent `8dbf0538e72f7ca09504640dcf80ef089f4550f9`.

This necessary rebase resolves a mock-baseline conflict by keeping main and removing exactly the same four retired Talk entries. Upstream fixture and Gateway inventory changes are retained. All five changed production files are byte-identical to the previously tested tree `61d9f1df2cc6b2d313609d49564c897bdc5e977e` on base `3c0f7e4c5cdade301b896970c9afbf4ab253de5e`.

- Current tree: fresh frozen install, 180 tests across nine owning files/eight canonical Vitest shards, and mock-baseline/conflict/line-cap guards pass. Formal repository autoreview completed scoped-clean through P2, with no findings. See `integration-validation.json`, `autoreview.json` and `autoreview-status.json`.
- Prior tree 61d9: 697 tests across 39 files, all canonical full-build steps, broader static checks and the real-Gateway replay passed. See the explicitly named `prior-tree-*` files. These are not current-tree full-build or runtime results.
- Earlier routing reproduction remains unchanged at https://github.com/ZengWen-DT/openclaw/tree/63fd7984c15074226751dc0fb2119706b77b9198/proof/issue-161885. It belongs to its original base/tree, not this repair.

Both current and prior local source trees were tested as staged deltas on their stated bases. GitHub publication added commit metadata afterward. No installed-package or metadata-only rerun claim is made.

## Current integration tests

Run with Node 24.19.0, pnpm 12.5.1, the current frozen lockfile and serial workers:

```sh
pnpm test \
  src/gateway/talk/client-agent-consult.routing.test.ts \
  src/agents/embedded-agent-runner/run/deferred-lifecycle-owner.test.ts \
  src/agents/run-termination.test.ts \
  src/agents/model-fallback.test.ts \
  src/agents/auth-profiles/source-check.async.test.ts \
  src/talk/agent-consult-runtime.test.ts \
  src/talk/agent-consult-runtime.storage.test.ts \
  src/talk/agent-consult-runtime.lineage.test.ts \
  src/config/sessions/session-accessor.parent-fork-worker.test.ts \
  --maxWorkers=1
```

The observed wall time was 231.497 seconds, with `OPENCLAW_TEST_PROJECTS_PARALLEL=1`. The current install uses its own virtual store and the supported `--package-import-method=hardlink` option against a task-owned content store; its files do not share inodes with the older reviewed install. No source dependency policy or lockfile was changed.

## Prior real-Gateway replay

The two `.mts` fixtures are the exact replay scripts used on tree 61d9. They start a real isolated source Gateway, invoke the actual host-injected consultation callback, and use a deterministic local CLI JSONL executable plus HTTP loopback provider. The synthetic media offer is nonfunctional. They clear inherited account/provider environment, create private temporary state, disable updates/telemetry/catalog refresh and background services, and use no commercial provider or live microphone.

To reproduce the historical record, check out base `3c0f7e4c5cdade301b896970c9afbf4ab253de5e`, keep these proof files outside the source checkout, and run `git apply --index <outside-proof-dir>/prior-tree-source.patch` to materialize tree 61d9. The `--index` is required: the immutable fixtures reject unstaged changes and record `git write-tree`. From the source root, use the repository's `scripts/tsx.mjs` loader to run the two fixtures. They write results into the sibling `talk-164229-repair-evidence/runtime` directory, so use an isolated parent directory. Do not check out this proof branch and call its larger tree the tested source tree.

`build-verify.mjs` preserves every canonical full-build step and bounds supported tsdown concurrency to one. The historical build used the documented private-QA build-child flag, explicit 6144 MiB heap, GOMEMLIMIT=2GiB, GOMAXPROCS=2 and GOGC=30. It completed in 1696.478 seconds.

`extract-runtime-evidence.py` validates the recorded outputs and emits whitelisted observations. Supply the actual host exit codes and separately observed source identity; JSON existence alone is not success. Its 93 derived checks are not 93 additional software tests. All 15 recorded runs have one terminal. Reduced CLI launch policy is observed in arguments, not by attempting forbidden tool calls. Claim acceptance demonstrates claim custody, not provider-side append effects.

CLI/fallback retain a preverified human sentinel and two answers with generated consult turns hidden. Direct embedded drops the sentinel; no current-baseline comparison or history fix is claimed. Original-host cleanup checks exact fixture command paths before SIGTERM, and Gateway shutdown/host exit are clean. Joined CLI-child reaping across process namespaces remains unproven.

## Remaining limits

The current-tree full build, global aggregate and real-Gateway replay were not repeated after the ancillary-only rebase. Fresh exact-head hosted CI remains separate evidence. On the prior tree, global extension typing and root-other test typing exited 137 without TypeScript diagnostics; three full-lint shards were SIGKILLed. Other root test graphs, 25 lint shards and targeted checks passed, but these do not constitute a full-gate pass.

This proof does not cover live audio/playback, commercial-provider behavior, installed packages, deployment, or composition with sibling PRs #164771 and #164417. Raw local outputs with synthetic grants, identifiers, argv, prompts and paths are excluded.
