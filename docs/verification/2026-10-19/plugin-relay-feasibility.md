# Fixed-target relay implementation and qualification

Date: 2026-10-19. The paired Docker driver and relay are implemented. The current
packaged-reference-plugin qualifier passed on local macOS/Colima and Linux amd64
Docker 29.9.1. This record keeps the earlier Linux standalone feasibility
experiment separate from those paired-driver runs. Neither qualifies full
distribution or P5/P6 acceptance.

## Historical Linux standalone feasibility

The Linux amd64 Docker 29.9.1 experiment used the implementation baseline
`2703005aaf3c420335d0e87a1b4044e254a5a41a` and ran the standalone
`PLUGIN_RELAY_PROGRAM` from `apps/api/src/plugin-relay-program.ts`:

- Program SHA-256:
  `1ffeaa642833ada48edba7c581ed78e480db370cda216d3f7756cfbe99b3c5cc`.
- Cached image:
  `docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
- One synthetic HTTP target on an internal bridge with IPv4 gateway mode
  `isolated`, unpublished and attached to exactly that bridge.
- A separate fixed-target relay joined that bridge and a normal control bridge.
  Its effective published port was exactly one literal `127.0.0.1` binding.
- Both containers used UID/GID 65532, read-only root filesystems, no supplied
  mounts, all capabilities dropped, no-new-privileges, 0.5 CPU, 256 MiB memory/
  swap and 64 PIDs. The relay had only three non-secret target/listen settings;
  no application/provider credential or Docker socket was mounted.

The target was an operator-owned minimal HTTP fixture, not the independently
packaged reference MCP artifact. The experiment used Docker CLI operations,
not the paired driver or production gateway.

| Path | Observation |
| --- | --- |
| Direct host loopback through relay to configured target | HTTP 200 and exact synthetic target body |
| Plugin container publication | No requested or effective published port |
| Plugin network membership | Exactly the isolated internal bridge |
| Relay membership/publication | Exactly its two intended networks and one effective loopback mapping |
| Public HASI health from normal-network relay control | HTTP 200 |
| Same public health from isolated plugin | Request denied or timed out |
| Temporary host HTTP fixture from normal-network relay control | HTTP 200 |
| Same host fixture from isolated plugin | Request denied or timed out |

The host fixture listened only on the owned normal bridge's gateway address;
it did not touch an existing host application. Direct host HTTP requests bypassed
HTTP proxy configuration. Both containers, both owned networks and the temporary
host listener were removed; the complete before/after container inventory
matched. The sanitized report was retained on the operator host as
`hasi-fixed-relay-network-6518af833f11.json`. This establishes feasibility for
those paths on that Linux configuration, not qualification of the current driver.

## Current driver and relay inputs

The current implementation retains these pinned relay inputs:

- Program SHA-256:
  `1ffeaa642833ada48edba7c581ed78e480db370cda216d3f7756cfbe99b3c5cc`.
- Relay image:
  `docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
- Fixed target: the actual inspected private IPv4 of the candidate and its
  declared service port. The plugin remains unpublished; only the relay has an
  effective host mapping, which must be exactly one `127.0.0.1` binding.

`createDockerPluginDriver` requires the operator to supply a distinct
`relayNetwork` plus approved `allowedInternalNetworks`. It inspects each
network's owner/managed labels and actual mode, and requires each internal
generation network to be empty and configured with IPv4 gateway mode `isolated`.
It also inspects the relay image already present in Docker's local image store;
the staging path makes no image-pull request. The exact `hasi` labels and
network options are documented in the
[operator configuration](../../architecture/production-runtime.md#operator-local-docker-container-composition).

The driver creates and verifies the candidate/relay pair, including actual
container identity, environment, mounts, hardening, network membership and
effective ports. Relay environment inspection allows only the pinned Node
image's standard `PATH`, `NODE_VERSION` and `YARN_VERSION`, plus exactly the
three assigned target/listen settings. Candidate ingress is represented as a
loopback relay endpoint, not as a published candidate port. Lost create/start
replies and ambiguous same-name orphans remain `unknown` until exact operation
ownership is reconciled; cleanup verifies the pair and active-route fence,
removes the relay first, then the inactive candidate.

## Relay child-process tests

The local suite passed 16 real child-process tests. In addition to fixed-target
raw TCP forwarding, input rejection, byte and connection limits, and shutdown
behavior, elapsed-time tests now exercise all three timers:

- Connect-timeout recovery uses a test-only preload that returns an unconnected
  socket for one target connection. It exercises the real 2-second timeout and
  slot recovery without relying on a network blackhole.
- An actual 10-second idle expiry closes both sides of the connection and frees
  a slot while other connections send keepalives.
- An actual 30-second maximum lifetime closes both sides despite periodic
  heartbeat traffic, then accepts a new connection.

These tests validate the standalone program's limits on the tested runtime. They
do not prove the driver, network, gateway or image behavior on every platform.

## Current local macOS/Colima qualification

The actual paired driver and packaged native MCP reference plugin completed the
local Colima qualifier with `qualified: true` and cleanup verified. The native
MCP read count was one and the driver health check passed. Docker inspection
confirmed the candidate was unpublished, the relay had only its effective
loopback mapping and assigned non-secret environment, and its network membership
was the intended internal plus normal relay bridges. A public-health control on
the normal relay bridge returned HTTP 200; the isolated plugin's public request
was denied. The qualifier restored the original container inventory.

This result is synthetic local technical evidence. It does not establish
institutional identity, real service authorization, a production deployment or
M8 acceptance. The qualifier reported `fullDistributionAcceptance: false` and
`fullP5P6Acceptance: false`.

## Current Linux paired-driver qualification

The packaged reference plugin also passed the actual paired driver on Linux
amd64 with Docker 29.9.1. The
[sanitized result](plugin-paired-linux-result.json) records `qualified: true`,
one native MCP read matching the expected synthetic context, a successful
driver health check, an unpublished plugin, a relay attached to exactly its two
intended networks with one effective loopback-only mapping, and only assigned
non-secret relay environment. Public health returned HTTP 200 from the
normal-network control and failed from the isolated plugin. Cleanup was verified.
The [paired-driver record](plugin-paired-driver.md) documents operator
provisioning, package transfer and exact cleanup evidence for this run.

This Linux result is a current native-driver proof for the qualified synthetic
case. It remains separate from the earlier Linux minimal-HTTP Docker CLI
experiment above, which only established basic relay network feasibility.

## Remaining acceptance evidence

Still open are integrated production gateway traffic; update, failed-staging,
restart/process-replacement and rollback recovery; independent artifact
distribution; and the remaining P5/P6 negative and acceptance cases.
Actual-device and institutional testing remains M8 work. No business tool,
model request, real identity, production database mutation, budget reset or
artifact publication occurred in these qualification runs.
