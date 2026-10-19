# Source-committed Anny action recovery

Date: 2026-10-19. Baseline `bd599280ee16d9b002697c6af38a0d1237269fc3`
with the source identities below. This is bounded technical M5 evidence against
the synthetic Anny service. It does not establish vendor idempotency or tenant
reconciliation support.

## Failure and implementation

The source can commit a booking or cancellation before its HTTP response is
lost. The plugin's execution journal then contains an unknown outcome instead
of a result. Replaying the source mutation would risk a duplicate action.

The SDK now offers an optional trusted, read-only reconciliation hook. It is
called only for an existing journal record with the exact subject, installation,
execution UUID, tool, argument digest and configuration revision. Results must
satisfy the current tool output schema before a compare-and-set stores them.
A missing, foreign or already confirmed journal record does not call the hook.
Concurrent execution responses cannot overwrite a confirmed source receipt.

The Anny plugin accepts exactly one source receipt and rechecks its full binding,
current customer/resource rights, original arguments, owned booking, resource,
interval and current status. Missing, ambiguous, altered or unowned evidence
cannot confirm an outcome. Matching only a room and time is insufficient.

The synthetic source stores a correlated receipt in the same aggregate CAS as
the booking or cancellation. Its service-bearer-protected header and read-only
`_hasi-demo/execution-status` endpoint are explicit mock capabilities. They are
not added to the documented Anny client or represented as public Anny APIs.
The demo runtime supplies the correlation from verified invocation context;
source workspace scope is fixed by server configuration, independent of
request headers. The existing source aggregate retains its seven-day demo TTL;
receipts are not individually evicted. At the bounded receipt limit, a new
correlated mutation fails before changing source state.

## Observed cases

The HTTP integration test runs separately with memory and local disposable
PostgreSQL storage. Each uses two runtime instances sharing one store and a real
loopback HTTP listener. It drops a successful source response after commit and
before the Anny client receives it, for both create and cancel.

- Create returns `outcome_unknown` after exactly one source mutation.
- Another test workspace cannot reconcile the proposal or query its source
  evidence. An immediate repeated status request is rate limited.
- Temporarily absent source evidence retains `outcome_unknown` with no replay.
- After the existing ten-second status cooldown, the exact source receipt
  confirms the original booking. Repeating confirmation adds no mutation.
- Cancellation has the same response-loss recovery. Total source mutations are
  exactly two: one create and one cancel, including repeated confirmations.
- Disconnecting the personal account after preparation rejects confirmation
  with HTTP 403 and zero additional source writes.

SDK tests exercise bound-row lookup, schema validation, oversize/malformed
results, CAS conflicts, and late success/failure races. Source validator tests
exercise missing/duplicate receipts, foreign customer/subject, changed arguments,
execution/configuration, wrong resource/time/status, revoked resource rights,
and cancellation against a different booking. Mock tests reconstruct persisted
state and reject a spoofed workspace header against a differently configured
source instance.

Root backend build, root/web type checks, 37 focused tests across five files,
and scoped lint passed.
The required complete integration/CI matrix is still pending this branch's
integration order. No model request, real Anny write or production database was
used. Physical-device, institutional identity and real tenant conformance
remain M8; this report alone does not accept M5 or its prerequisite milestones.

## Tested source identities

| File | SHA-256 |
| --- | --- |
| `packages/plugin-sdk/src/execution-journal.ts` | `452abe20d60e8bcb9c99029889473fd996b42456ead3cbffa73b464427244fc1` |
| `packages/plugin-sdk/src/server.ts` | `cd1273923963cb330dae4834d363f0cf32d55bf96b23252a9513aadde50ad90c` |
| `apps/anny-mock/src/execution-evidence.ts` | `61801ee620a5c06884930f2ad3e399e6ffad38ff3bc6e6d42143067b70e45d36` |
| `apps/anny-mock/src/index.ts` | `bf43840aabe7de00b723b4669fc7eb1a45e0386dc3b5d98756616d2b22d9599f` |
| `apps/anny-plugin/src/source-reconciliation.ts` | `2fae5ba9e8dda83fa04380365835ab76a91ff2452b3ebe6626cca872bef0690b` |
| `apps/anny-plugin/src/index.ts` | `b8714fe0fe5f7e0aba6061ad229adac5ff4103f3c4f9f36507fc6a37c94e4a1a` |
| `packages/demo-runtime/src/anny-execution-evidence.ts` | `12a2db09bb49fc2be7f6e65962e68ec9b8c875bc9325f1b9a165c5b6b68aea0b` |
| `packages/demo-runtime/src/index.ts` | `e5dfa3c8b84decf80e58244dc1f69b5fb7463fb7881a7173292821e331bcb7f2` |
| `tests/anny-source-reconciliation.test.ts` | `deeec16c48811574bb52c582104e60a917ba1eda05ef7acbf6d04132689384cf` |
