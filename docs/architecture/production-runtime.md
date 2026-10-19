# Separate production runtime

Implementation decision: 2026-10-18; qualification sequencing updated 2026-10-19.
Plan V4 keeps automated/mock and technical operational qualification in M1–M7.
Actual-device/native accessibility, institutional participants, real HsH identity,
source/vendor conformance and protected-data approval belong to final M8.
Synthetic identities or successful compilation do not establish institutional acceptance.

## Processes and authority

- The Next.js frontend runs separately from the TypeScript API. Set server-only
  `HASI_APP_MODE=production`, `HASI_WEB_ORIGIN` and `HASI_API_ORIGIN` to distinct
  HTTPS origins. The frontend's API handler forwards bounded requests only to
  that configured origin, with no redirects followed and no caller-provided
  Authorization/forwarding headers. OIDC redirects and host-only session cookies
  are returned through the frontend origin.
- `createProductionRuntime` constructs the durable registry, authority directory,
  OIDC provider and API. It rejects process-local memory storage and non-HTTPS
  web configuration. `ProductionAuthorityDirectory` binds signed grants to scope
  and stable issuer/subject-derived identity. Provision/replace/revoke grants
  through this operator API with an expected store revision. There is no public
  grant-writing route; initial user provisioning is an operator prerequisite.
  E-mail or a selectable persona cannot become production account authority.
- A catalogue entry is permission for an administrator to connect a reviewed
  service. Startup restores durable connections and does not reinstall removed
  services. Every approved source needs a host-owned source ID, policy revision
  and data classifications. Model schemas and user payloads cannot select
  endpoints, custody references or installation sources.
- Personal services additionally receive an operator-created
  `PluginAccountService` in the runtime's `accounts` map. Its trusted adapter owns
  upstream authorization/custody and fresh rights checks; demo adapters are
  rejected in production. Register the upstream callback at
  `/api/plugin-accounts/<installationId>/callback`. Its state is one-use and bound
  to the authenticated subject and installation. Adapter authorization origins
  are pinned independently of the URL returned by the provider.
- Executable plugins run in isolated workers. The API does not accept arbitrary
  repository URLs or run their install scripts. An operator connects a reviewed
  remote service or deploys a publisher-signed, digest-pinned artifact through
  `PluginDeploymentCoordinator` and the Docker driver. Do not give public demo
  administrators or plugin containers access to Docker Engine.

The standalone entrypoint `apps/api/src/production-server.ts` consumes a bounded,
version-1 JSON operator document from `HASI_OPERATOR_CONFIG`. It supports reviewed
remote sources, logical environment credential slots, fixed OIDC configuration
and reviewed action descriptions. It reads `DATABASE_URL`, `HASI_PRIVATE_KEY`
and optional `HASI_OIDC_CLIENT_SECRET` only in the API process. It does not create
initial authority grants, personal provider adapters or institutional rights.
Use the exported runtime factory for those institution-specific compositions.
No real HsH configuration is committed with this example entrypoint.

Build with `pnpm --filter @hasi/api build`; the emitted entrypoint is
`apps/api/dist/production-server.js`. Startup requires explicit
`HASI_MODE=production`. Binding defaults to `127.0.0.1:4100`; configure a trusted
HTTPS reverse proxy and `apiHostname` for the API. The launcher does not print
credentials or configuration contents on failure. This is an implementation
path, not a record of an institutional deployment.

## Worker routing and configuration

Use one durable `PluginRouteController` namespace across API/operator replicas.
Its atomic route record contains the active deployment, immutable release digest,
configuration revision and terminal operation fences. The operator-local Docker
resolver checks the active candidate/relay pair, exact image/release, isolation
settings, actual network membership and health. The candidate stays unpublished;
only the paired relay may have the exact effective `127.0.0.1` port mapping.
The resolver rechecks both containers and the route before forwarding.

Start `createPluginDeploymentGateway` before the registry connects managed
plugins. The gateway has its own loopback-only listener, no browser session state
and an installation-specific service-credential check. Only MCP, pinned manifest,
health and signed action-status paths are exposed. Redirects, queries, cookies
and arbitrary headers are rejected or withheld; body/response/time limits apply.
This gateway carries traffic to the active container rather than only updating
deployment metadata. A switch after dispatch may still create an uncertain write;
execution IDs and authoritative receipts handle that uncertainty.

In a separate worker process, point approved registry endpoints to the worker's
authenticated gateway using an explicit transport policy. For local operator
composition, `createProductionRuntime.managedGateway` starts and closes the
gateway, pins its exact literal `127.0.0.1` origin through a private registry
composition option, constructs fixed endpoints for the named approved
installations and requires a `deploymentBindings` entry for each. Ordinary
production loopback access remains denied; manifest/browser/registration values
cannot enable this exception. `PluginDeploymentBinding`
converges route configuration after settings activation and denies invocations
while settings and route revisions disagree. Missing synchronization does not
fall back to the old worker/configuration. All replica instances must use the
same durable settings and route stores. Keep operator deployment controls outside
the public API.

### Operator-local Docker container composition

`createDockerPluginDriver` is an explicit operator-local composition. It requires
`enabled: true`, `deploymentTarget: "operator-local"`, an absolute Docker socket
path, a server-owned `ownerId`, `allowedInternalNetworks`, the distinct required
`relayNetwork`, an operator-owned routing controller and a server-side secret
resolver. It refuses Vercel and demo-mode processes. This driver is not enabled
by the public demo or the standalone JSON production entrypoint; trusted
application wiring must provide these options. Never give the Docker socket to
a plugin container or public administrator.

The operator provisions an empty internal bridge for each deployment generation
and includes its name in `allowedInternalNetworks`. The requested name in the
launch policy must be an exact member of that list. Internal networks must be
Docker `bridge` networks with `Internal=true`, IPv6 disabled and
`com.docker.network.bridge.gateway_mode_ipv4=isolated`. Both the internal bridge
and the distinct normal bridge named by `relayNetwork` must carry
`hasi.managed-by=hasi-docker-plugin-driver-v2` and
`hasi.owner=<ownerId>` labels. The relay bridge must have `Internal=false` and
is reserved for platform relay containers for that owner. The driver inspects
actual settings and membership, rejects an occupied generation bridge, and
requires the internal bridge to contain only its candidate and paired relay.
Labels do not replace Docker inspection.

For an internal launch, `PluginContainerLaunchPolicy.ingress` records
`hostAddress: "127.0.0.1"`, the host ingress port and the plugin service port.
The candidate container receives no host port binding. The relay is pinned to
program SHA-256
`1ffeaa642833ada48edba7c581ed78e480db370cda216d3f7756cfbe99b3c5cc` and image
`docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
That image must already be cached locally: the driver verifies its exact local
digest and does not pull images. Relay inspection permits the pinned Node image's
standard `PATH`, `NODE_VERSION` and `YARN_VERSION` plus exactly the assigned
target address, target port and listen port. It rejects other environment
entries; no plugin secret or custody reference reaches the relay. A relay image
or program change requires fresh compatibility qualification.

The packaged reference plugin passed the local macOS/Colima qualifier and a
Linux amd64 Docker 29.9.1 paired-driver qualifier, with one native MCP read and
a successful driver health check on each. Both runs verified an unpublished
candidate, loopback-only relay publication, a successful normal-network
public-health control and denied public health from the isolated plugin, then
restored their owned container inventory. Integrated production gateway traffic,
update/recovery/rollback, independent artifact distribution and full P5/P6
acceptance remain open. See the [qualification summary](../verification/2026-10-19/plugin-relay-feasibility.md),
[paired-driver record](../verification/2026-10-19/plugin-paired-driver.md) and
[sanitized Linux report](../verification/2026-10-19/plugin-paired-linux-result.json).

## Credentials and model context

`EnvironmentPluginSecretCustody` accepts only operator-created logical bindings
to `HASI_PLUGIN_SECRET_*` names. The interface exposes readiness and a non-secret,
operator-assigned revision, and lends a value only to trusted transport/worker
code. Public drafts never contain values or custody references. Replacement or
revocation changes the approved revision; active configuration/confirmation
bindings include that revision. Secrets do not enter signed actor claims or
model/tool payloads. The environment object is not serializable through the
custody instance.

The production frontend requires a durable `HASI_CHAT_SIGNING_SECRET` distinct
from model and plugin credentials. Its model/budget configuration continues to
use the existing provider registry, approved prices and shared admission ledger.
Missing configuration or provider eligibility denies calls; no demo fallback is
used. The shared budget must be explicitly initialized before model use.

Until M3 supplies a server-owned, revocable retained-context store, the generic
production API conservatively marks the entire conversation as potentially
public, internal and confidential. `HASI_CONTEXT_DATA_CLASSES` defaults to all
three and cannot be narrower than the API's policy: disagreement fails closed.
Profiles must be approved for the complete set. This intentionally prevents a
public-only configuration from silently forwarding earlier protected history.
It is not a content scanner, source-rights substitute or institutional provider
approval. Trusted, revocable source-specific context processing remains M3/M6.

## Plain MCP adaptation and action receipts

`createReviewedPlainMcpAdapter` wraps a reviewed plain MCP service behind HASI's
signed identity/effect boundary. Each tool has an explicit mapping, exact upstream
schema digests, expected server name/version and trusted authorization/argument
projection. Only then is a delegated/scoped credential resolved. Changed tool
discovery, redirects, unstructured/oversized results and missing authorization
are rejected. A plain MCP declaration never establishes user rights by itself.
Writes require a durable `ExecutionJournal`; adapters still need source-specific
uncertain-write semantics before live institutional writes.

Every production action needs a reviewed `ActionPolicy` supplying the exact
service/account, consequences and costs. Its revision binds pending proposals.
The JSON launcher supports fixed reviewed descriptions for service-owned flows;
personal accounts, dynamic fees/terms and eligibility checks need a programmatic
source-specific policy. Its account label must identify the actual linked
account, not merely echo an unverified upstream string.

`ExecutionJournal` commits a receipt before returning a successful result. The
host's explicit status check validates actor, installation, arguments, execution
ID, configuration, output schema and current rights before projecting it through
the same host-provenance boundary as a normal result. If a process dies between
the upstream write and durable receipt, the result remains unknown. Supply a
reviewed authoritative reconciliation callback; never rerun the write to learn
whether it succeeded. Disconnected or revoked accounts cannot use old receipts
to regain access. Retained chat text is not an execution authorization.

The separate Next.js/two-API identity/session topology has a runnable synthetic
qualification below. Local Docker qualification covers the paired container
and native MCP path on macOS/Colima and Linux amd64 Docker 29.9.1. Production
gateway integration, deployment update/recovery, independent artifact
distribution, integrated model-budget behavior and automated browser journeys
remain technical M2 work. Native assistive-technology and institutional
end-to-end acceptance is M8.

## Content-free operational events

The production API emits `api.request.completed` through a trusted server-side
sink. Fields are a fresh server UUID, registered route template (or `unmatched`),
a bounded HTTP method, response status and monotonic elapsed milliseconds.
Raw paths/queries, headers, cookies, bodies, claims, user identifiers, credentials
and exception messages are excluded. Fastify request logging stays disabled.
The frontend returns only the valid backend `x-request-id`; an incoming ID cannot
choose it. Sink exceptions do not alter API responses or expose their payload.
This event is operational telemetry, not a durable authorization or action receipt.

## Isolated identity/topology qualification

Use a disposable local PostgreSQL database named exactly `hasi_topology_test`,
reachable through an explicit `127.0.0.1` port. The runner rejects URL query
overrides and never uses `DATABASE_URL`. Build the production frontend first:

```sh
HASI_APP_MODE=production pnpm --filter @hasi/web exec next build
HASI_TOPOLOGY_QUALIFY=1 pnpm exec tsx scripts/qualify-production-topology.ts
```

Set `TEST_DATABASE_URL` through the test environment; never put a real password in
shell arguments. The runner starts the actual Next.js handler and two distinct
API processes, verifies HTTPS using an ephemeral local certificate, and runs the
loopback-only Test-IdP with authorization code/PKCE. All child environments are
allowlisted; no model or plugin credentials are inherited. Nothing is installed
in the system trust store and TLS verification is never disabled.

Checks include cross-replica OIDC transactions and sessions, secure host-only
cookies, forged identity/Host/origin and replay denial, concurrent session reads,
an exact restarted-replica session check, current authority downgrade and logout
across replicas. Failed certificate trust is a counter-probe with the expected
TLS error. The runner removes its processes, listeners and temporary keys; its
isolated database is caller-owned and must be discarded after the run.
It makes zero model calls and does not qualify a plugin worker, a model budget,
native browser behavior or institutional access. Measured latency is descriptive,
not an agreed performance threshold. See the [dated evidence](../verification/2026-10-19/m2-runtime.md).

## Protected knowledge workspaces

The institutional knowledge implementation and separate worker/MCP launcher are
specified in [knowledge operations](institutional-knowledge-operations.md). Both
source exports must map identities to HASI's stable `stableOidcSubject(issuer,
subject)` projection and carry fresh authoritative source grants; e-mail or a
demo role is insufficient. Source/IdP owners must approve that mapping.

In OIDC mode the frontend requires durable `DATABASE_URL` workspace storage and
`HASI_CHAT_SIGNING_SECRET`. Protected chat contents stay out of localStorage.
`/api/chat/workspace` authenticates, checks origins, bounds input, sanitizes
source/derived context and uses subject-bound signed PostgreSQL CAS records.
The same reference resolution is repeated before model dispatch and on load.
The public Coolify fixture demo continues its separate local-history behavior;
adding a provider key never enables institutional access or processing approval.
