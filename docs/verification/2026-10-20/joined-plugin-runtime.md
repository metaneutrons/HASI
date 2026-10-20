# Joined synthetic plugin browser runtime

Date: 2026-10-20. Baseline: `a85358e9380e3036333590ccb1d06fffe91e00de`.
Purpose: exercise the remaining M2/P4/P6 journeys in the actual web application,
not only through separate API-injection tests. This is a qualification fixture,
not a passed milestone, institutional integration or real-model benchmark.

## Composition

`pnpm journey:serve` holds a local Next.js development server, two separate API
processes behind a round-robin loopback proxy, a TestIdP with declared synthetic
administrator/student choices, native Anny/knowledge fixtures, and an independent
reference-plugin process. The reference plugin is built offline from a separate
temporary Git repository into self-contained 1.0.0/1.0.1 artifacts, using the
existing SDK packaging verifier. It does not import the host workspace at runtime.
The launcher starts 1.0.0 and can explicitly restart that process or switch the
independent artifact to 1.0.1/1.0.0 while retaining its SQLite state. An artifact
switch alone does not qualify an administrator-approved managed update/rollback.
The SQLite file lives outside both versioned artifacts; it stores source receipts,
SDK execution receipts, scoped counters and invocation replay records. Both APIs use the same random signing key/scope and a
caller-supplied disposable PostgreSQL database. Personal reference/Anny accounts
begin unlinked and require the normal explicit synthetic consent path.

The local HTTPS model fixture accepts only its synthetic token and two declared
reference-tool hashes. It emits fixed responses and synthetic usage counters;
`stats` distinguishes
correlated bounded reference-read data from omitted results without echoing
tool output. The positive/counter-probes cover both outcomes. It
cannot execute an action, contact a real provider, establish answer quality,
prove prompt caching or measure real billing. The web child trusts only the
fixture certificate through `NODE_EXTRA_CA_CERTS`; normal TLS verification remains
on. Operator environment variables are not inherited by child processes. Next.js
dotenv files cause preflight rejection by file presence without reading them.
Use an isolated HOME and an already prepared package cache for the launch.

## Run

Prerequisites: Node/pnpm, Git, OpenSSL, installed/built workspace dependencies,
and an explicitly disposable PostgreSQL database named `hasi_topology_test` on
literal `127.0.0.1` with an explicit port. No URL password or connection-string
query override is accepted. Ports 3001 and 4100–4103 must be free.

```sh
journey_home="$(mktemp -d "${TMPDIR:-/tmp}/hasi-journey-home.XXXXXX")"
journey_store="$(pnpm store path)"
env -i PATH="$PATH" HOME="$journey_home" LANG=en_US.UTF-8 npm_config_store_dir="$journey_store" pnpm reference:prepare
env -i PATH="$PATH" HOME="$journey_home" LANG=en_US.UTF-8 npm_config_store_dir="$journey_store" HASI_PLUGIN_JOURNEY=1 TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32775/hasi_topology_test pnpm journey:serve
```

The last command is held in that terminal. Once the `plugin-journey-ready` event
appears, open `http://127.0.0.1:3001`. Its protected readiness probe actually
completes TestIdP login, checks the synthetic-data classification, loads the
protected workspace and logs its own session out. The browser journey remains
separate. Use the administrator choice to connect/configure/activate the approved
reference plugin, then connect the personal account under Connected services.
No institutional credentials are needed.

Terminal commands:

- `stats`: numeric model, source/journal and proxy observations only.
- `expire-anny`, `expire-reference`: advance the matching synthetic account clock.
- `reference-drop-reply`: discard the next successful `execute_mark` HTTP reply
  after the proxy has actually received a confirmed upstream result.
- `reference-lose-ack`: commit the next synthetic mark, then leave the SDK journal
  unknown; source reconciliation can prove the retained effect.
- `reference-source-unavailable`, `reference-source-available`: control that
  synthetic source resolver without exposing fault controls over HTTP/MCP.
- `restart-reference`: stop and restart the exact artifact against the same state.
- `reference-v2`, `reference-v1`: switch the independent process artifact, preserving
  state. Normal host compatibility/approval remains enforced. These commands do
  not perform managed installation approval or waive remote downgrade rejection.
- `quit`: stop owned processes and remove generated keys/artifacts/state files.

Commands are serialized. Reference controls use correlated IPC acknowledgements;
restarts require a graceful exit and new readiness before acknowledging. Account
clock advancement is acknowledged by both replicas before completion is
reported. `quit`, SIGINT/SIGTERM or the 30-minute bound stop owned processes and
remove generated keys/artifacts. The caller-owned database and its isolated
synthetic records are retained; cleanup never drops that database. A private
metadata-only evidence JSON identifies processes and packaged source/artifact
hashes while the runtime is active. Copy necessary non-secret measurements to
a durable verification report before stopping it. Temporary isolated HOME/cache
cleanup remains the caller's responsibility.

## Qualification of the fixture

The documented command block was executed verbatim: dependency preparation,
startup and the actual protected readiness probe succeed; `expire-reference`
reports acknowledgements from both replicas; `stats` reports zero real-provider
calls; `quit` confirms owned-process cleanup while retaining the caller's DB.
Focused tests cover identity selection/PKCE, malformed selection rejection,
database/dotenv admission, HTTPS trust rejection and model-data observation
positive/omission counter-probes. Root TypeScript, type-aware lint and the
production web build pass.

Independent source review found a failed-spawn cleanup defect: the PID was
checked before the asynchronous error handler was attached. The launcher now
registers/handles the child first. A real process test starts an owned Node
child, attempts a nonexistent executable, observes the handled error/close,
then proves that the earlier child stops with SIGTERM and repeated cleanup is
safe. The reviewer rechecked the repair without further actionable findings.
These are fixture checks; downstream journey findings below remain failures.

## Observed journey and open findings

The initial browser run reproduced a missing catalog-adoption failure between
already-running API replicas. The regression and correction are tracked in
[the catalog connection report](catalog-replica-adoption.md) and PR #136.
After correction, actual browser connect → configuration → draft save → explicit
activation → MCP connection test succeeds with API requests distributed across
both processes. The test does not qualify actual user rights merely because the
MCP transport responds.

Personal reference consent completed. The first account-status reload displayed
a temporary service error; an explicit status refresh then showed the account
connected. This remains a reproducible-journey finding to investigate.
A reference `read_status` request made two local synthetic-model calls and no
real-provider calls. Its assistant/tool output was subsequently redacted by
protected autosave. Source inspection shows that protected history currently
omits non-knowledge tool bodies and cannot retain generic result cards. Current
API provenance digests alone are not signed result evidence. Preserve the
fail-closed boundary and add verifiable per-result authority before treating
this as an accepted generic plugin conversation. A symptom-only relaxation of
history checks does not qualify that work.

Neither full account renewal/revocation/task return, independent artifact
update/rollback, unknown-outcome recovery, the complete mobile/keyboard matrix,
nor the local UI ≤200 ms target has been qualified by this run. M2/M6/M7 stay
open. Real-device and institutional acceptance remain M8.
