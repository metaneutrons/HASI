# Atomic state operations guarded by authority revisions

The `@hasi/state` package exposes `FencedJsonStore` as an extension of
`JsonStore`. Memory and PostgreSQL stores implement it. This is the storage
foundation for managed-plugin state continuity under P5-A3/P5-A4; it does not
expose a state service or connect managed plugins to persistent storage.

A trusted caller supplies a target key and between one and sixteen distinct
`StateFence` entries. Each fence names another key and its expected UUID
revision in the same store namespace. The store snapshots and validates these
inputs before asynchronous work. Every fence must exist, be unexpired when
checked, and match the expected revision. Failure returns no target content and
makes no target mutation. Invalid fence shapes throw rather than becoming an
unfenced operation. Missing/expired targets retain ordinary CAS semantics:
`null` creates or replaces an expired target; a stale target revision fails.

PostgreSQL locks the target and every existing fence row in a deterministic key
order within one transaction. It requires every fence to have appeared in the
locking result, then checks revisions and expiry in a fresh statement after any
lock wait. A row inserted after the locking snapshot therefore cannot become
an unlocked authority. Locks remain held through the target operation and
commit. The implementation uses transaction-local two-second statement and lock
timeouts, rolls back on failure, and discards a connection if rollback fails.
The underlying table and existing unfenced API are unchanged.

The memory implementation checks and mutates without an intervening `await`;
its state is process-local. It cannot prove durability or multi-process safety.
Fence expiry is checked at the operation's validation point, not promised to
remain in the future after the response reaches its caller.

## Remaining managed-plugin integration

This primitive is not authentication. Host-owned code must derive target and
fence keys from verified installation, actor and execution authority; a plugin
or client must not select arbitrary keys or authority revisions. Invocation
proof verification, deployment binding, minimized state schemas, replay and
receipt semantics, migration compatibility, limits and a narrow authenticated
transport still require implementation and qualification. The existing
[container isolation and relay boundary](plugin-container-connectivity.md)
remains unchanged: no new egress, host mount, socket or state endpoint is added.

The required managed v1-write → v2-read → rollback-read journey, process
replacement and uncertain-outcome handling remain open. The
[storage qualification](../verification/2026-10-21/fenced-json-state.md) does not
accept those runtime requirements or complete M2/M7.
