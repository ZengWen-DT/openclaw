# Buzz ambient-thread ancestry proof

This is synthetic relay transport proof for OpenClaw PR #145747. It uses an
isolated loopback WebSocket relay and generated identities. It does not contact
a hosted Buzz service or a real account, and is not a native-client recording.

## Source and candidate

- Baseline: `be8190f2f8c4f63eb2a3831a32dfd3e127573fe7` (canonical OpenClaw main captured 2026-10-03).
- Candidate: `9a0ccd6fb6025a9b8e3f0a1f554641889197e562`
- Candidate channel.ts SHA-256: `3fbe7df6880613b053eac02439d68f8ee6cf38e11c978f2c6e2df9ca4b8bc2ba`.
- Baseline channel.ts SHA-256: `a5ee1f12462ea5d85e9aed4918dd3fe55946fafc417ba4114284f216e031683c`.
- Environment: Linux, Node 24.19.0, pnpm 12.5.1, frozen lockfile, separate physical installation.

Both variants ran the same proof script and dependencies. Only the production
Buzz channel.ts file was switched between unmodified main and candidate. No
shared-dispatch, outbound-adapter, tag-builder, signing, or relay-authentication
function was mocked or replaced. The registry is a test-owned isolated registry;
the runtime is the production `createPluginRuntime`.

## Contract source

The synthetic relay validates signatures, NIP-42 identity/challenge/relay URL,
room membership, and NIP-10 ancestry against stored signed parent events. The
ancestry rule is derived from the real Buzz relay, pinned at
`8af2d91f37270365d5cd9170ac48349baa08475e`:

- [Marker parsing and resolution](https://github.com/block/buzz/blob/8af2d91f37270365d5cd9170ac48349baa08475e/crates/buzz-core/src/nip10.rs#L29-L81): reply-only means the parent is also the claimed root; root plus reply names both.
- [Relay ancestry validation](https://github.com/block/buzz/blob/8af2d91f37270365d5cd9170ac48349baa08475e/crates/buzz-relay/src/handlers/ingest.rs#L922-L1007): the claimed root must equal the stored parent's effective root, and parent and reply must share the room.
- [Parent-tag fallback](https://github.com/block/buzz/blob/8af2d91f37270365d5cd9170ac48349baa08475e/crates/buzz-relay/src/handlers/ingest.rs#L1030-L1057): root recovery when the parent has no thread-metadata row.

This fixture is deliberately smaller than the complete Buzz relay and does not
claim to test its database, deployment configuration, native UI, or every policy.

## Observed result

Entrypoint: `buildThreadingToolContext` → `runMessageAction` → Buzz outbound adapter
→ `sendBuzzTextOneShot` → signed, authenticated WebSocket publication.

- Baseline: the implicit mid-thread reply omits the thread root, emits only the
  child reply tag, and receives `OK:false` with
  `invalid: root tag does not match thread ancestry`. Shared dispatch surfaces
  the error. Explicit-child-without-thread also fails for the same reason.
- Candidate: all eight sends receive `OK:true` after signature and authentication
  checks. Implicit same-room and uppercase-canonical-room sends reply to the
  root. A different room receives no inherited thread/reply tags. Explicit child
  sends retain both the root and child. Explicit root, top-level, null-thread
  opt-out, and root-trigger controls preserve the intended tags.
- The candidate's main scenario supplies neither `threadId` nor `replyTo`.
- Logs use aliases for generated room/event identifiers and omit all key material,
  authentication payloads, and ephemeral network endpoints.

Measured transport script wall times: baseline 22.14 s; candidate 22.59 s.
See `relay-baseline.log` and `relay-candidate.log` for the observed wire outcomes.

## Reproduce

From a secretless checkout at the candidate with its pinned frozen dependencies:

```sh
node --import ./scripts/tsx.mjs /path/to/buzz-thread-proof.mts .
```

For the negative control, preserve candidate `extensions/buzz/src/channel.ts`,
restore that one file from the baseline SHA above, and run:

```sh
node --import ./scripts/tsx.mjs /path/to/buzz-thread-proof.mts . --expect-baseline
```

Restore the candidate file afterward. The script creates and closes its own relay
and temporary state, and prints a SHA-256 of the production file it actually ran.
