# Demo model-budget loss recovery

This procedure applies when the disposable demo loses its shared budget ledger
and no authoritative accounting can be restored. Demo backup/restore is not an
M7 requirement, but the shared USD 1/day model-call ceiling remains in force.
An empty replacement database does not show that the demo spent nothing during
the current UTC day. Keep model admission disabled until the budget window
containing the latest possible provider dispatch has safely ended.

The ledger uses one 24-hour UTC window. The production router fails closed when
the deployed ledger is missing. The operator initializer is privileged: it can
create a new empty ledger in a replacement database, so do not run it until the
safe time below or after a verified authoritative accounting recovery.

## Containment and safe time

1. Stop new model requests and any model probes or evaluation jobs. Drain or
   stop every running HASI replica and wait for in-flight provider requests to
   finish or time out. Record the latest possible provider-dispatch time after
   that drain. Use the later shutdown time if provider dispatch timing is
   uncertain. Keep model admission disabled during the recovery. Remove any
   one-off `HASI_INITIALIZE_MODEL_BUDGET=1` build setting before an automatic or
   manual deployment; initialization during a build must not bypass this hold.
2. With no authoritative accounting, calculate the safe recovery time from the
   latest possible dispatch `t`:

   ```text
   safeAt = (floor(t / 86,400,000) + 1) * 86,400,000 + 60,000 milliseconds
   ```

   This is one minute after the next UTC midnight following `t`. The margin
   allows the UTC boundary to pass cleanly. Do not initialize or re-enable model
   admission before `safeAt`. If a missing-ledger route is reachable during the
   hold, it must return `budget_unavailable`; investigate immediately if a
   provider request is dispatched.
3. Confirm the replacement database destination through the deployment's
   approved operator controls. Keep its connection string and credentials in
   server-side secret custody; do not copy them into tickets, shell history,
   logs or this runbook.
4. At or after `safeAt`, provision the shared ledger from the server environment
   that already has the intended `DATABASE_URL`:

   ```sh
   node --conditions=react-server --import tsx \
     apps/web/scripts/initialize-model-budget.ts --initialize
   ```

   The command preserves existing state if a ledger is present. On a genuinely
   empty replacement database it creates the current window's record. Verify
   its aggregate output shows an initialized ledger, the current UTC window,
   the approved token and USD limits, and zero usage. Stop if the window,
   limits, or database destination is unexpected.
5. Restore service only after the ledger check succeeds. The initializer's
   aggregate output does not prove provider connectivity or invoice accuracy;
   do not use a provider probe as part of recovery unless separately authorized.

If complete authoritative accounting for the current window is available, an
operator may instead restore it before resuming model calls. That accounting
must include every possible reservation and unknown-use hold, with the active
budget policy. A blank ledger, a successful deployment, or an empty database is
not authoritative accounting. This demo procedure does not restore lost
sessions, actions or other database state.

## Isolated technical drill

The optional `--state-loss-drill` mode extends the existing local qualification
after it has made synthetic reservations that exhaust the USD 1 limit. It
deletes only the budget ledger row from the harness-owned, labelled, loopback
PostgreSQL fixture. It checks production-built chat responses on both live
replicas, a request after replacing one replica, zero new ledger rows and no
increase in fake-provider requests. It does not delete the identity/session
rows or claim whole-database restoration.

The final clock phase uses the real fixture PostgreSQL row with an injected
ledger clock to check denial before the UTC window ends and continued denial
afterward until explicit operator initialization. It is ledger-level evidence;
the production router's clock is not changed. The drill makes no real provider
calls, uses no operator database URL, and requires the exact pinned PostgreSQL
image to be cached. Cleanup removes only the harness-owned container and
temporary files, and the qualification report is emitted only after cleanup
succeeds.

In a clean checkout with locked dependencies, no web `.env*` file except
`.env.example`, local Unix Docker access and the pinned PostgreSQL image already
cached, run:

```sh
env -i PATH="$PATH" HOME="$HOME" pnpm build:backend
env -i PATH="$PATH" HOME="$HOME" HASI_APP_MODE=production pnpm --filter @hasi/web build
env -i PATH="$PATH" HOME="$HOME" HASI_BUDGET_QUALIFY=1 \
  pnpm exec tsx scripts/qualify-model-budget-topology.ts --state-loss-drill
```

Do not set `DATABASE_URL` or `TEST_DATABASE_URL` for this command. The harness
rejects inherited database URLs and uses only its own container. A passing drill
qualifies this synthetic missing-accounting behavior; it does not establish a
real incident response, model/provider integration, production billing limit,
or institutional acceptance.
