# Public demo health monitor

Status: the merged monitor has now completed an observed scheduled run from a
GitHub-hosted runner, with both offline tests and the real public probe passing.
This establishes the bounded independent monitoring slice; complete M7 remains
open. The dated evidence below does not claim a strict schedule or full chat,
provider, plugin, booking or institutional availability.

The monitor uses a GitHub-hosted runner to request the fixed public endpoint
`https://hasi.metaneutrons.cc/api/health`. It uses the Node fetch implementation
with normal TLS verification, rejects redirects, has a 15-second abort timeout
and reads at most 8 KiB. It accepts only HTTP 200 with exactly the JSON fields
`status: "ready"` and a lowercase 40-character hexadecimal `revision`. It does
not accept an origin from environment variables or command-line arguments.
Failures produce a short allowlisted code; the response body, URL, transport
error, environment and credentials are not printed.

The route requires a valid `HASI_BUILD_REVISION`, verifies that budget admission
can be read and performs a read through durable chat storage. It does not reserve
budget or write state. A ready response therefore indicates only those readiness
checks and a bound build revision. It does not establish full chat behavior,
provider availability, account/session behavior, plugin/source access, booking
behavior, backup recovery or an expected-release match.

The workflow definition schedules a probe every 30 minutes and supports manual
dispatch. The public request runs only for `main`; pull requests and other branch
runs execute the offline tests without probing the public service. The tests use
an injected fake fetch and make no network calls. No repository secrets or
dependency installation are required. This check does not add backup work or
change the demo's no-backup scope decision.

GitHub's scheduled workflow is best effort, not a strict 30-minute service-level
guarantee. A failing run is visible as a failed Actions run; this workflow does
not create a separate alerting channel. An operator must notice and investigate
the failed run. After review, one manual probe of the public endpoint passed with revision
`abd65199fdabef6abc55c398fe3c880249a5d087`. The first observed successful scheduled run is recorded below. Remaining M7
technical prerequisites and application/operational journeys still require their
own evidence before full M7 acceptance.

Offline verification command:

```sh
node --test scripts/operations/demo-health.node-test.mjs
```

Local verification: Node 24.21.0 passed all 13 offline tests, including the actual
CLI exiting with code 1 and sanitized output under an injected HTTP 503; the workflow passed
`actionlint`. The workflow probes only main after its offline-test job succeeds;
PR probes and duplicate feature-branch push runs are excluded.


## Observed scheduled execution — 2026-10-19

[Run 39311951600](https://github.com/metaneutrons/HASI/actions/runs/39311951600)
was created at `2026-10-19T19:33:16Z` with event **schedule**, using source
`c4c55efc9506b8bbfc273101baff80b20c2d3cfb`. It completed successfully. Both
`Offline monitor tests` and `Public demo health` completed successfully; the
public probe job is `118264996232`. This is a scheduled external execution,
separate from the earlier manually dispatched positive probes.

The public job returned exactly one ready result at
`d0fae9cce662bf8a1dd32298fc74ae9de0f0e985`; its selected log output was parsed
against the exact ready/revision JSON contract. The probe allows any valid ready build
revision; a green monitor does not prove that the newest main build has already
deployed. GitHub scheduling remains best effort and uses failed Actions runs as
its operator-visible failure signal. No separate notification service, model
request, authentication secret or backup resource was introduced.

Monitor source SHA-256: `10bdecb11533d6f6bce390692058c054d4e137fde1448a961ec9580fe56abea5`.
