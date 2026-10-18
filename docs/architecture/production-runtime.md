# Separate production runtime

Implementation decision: 2026-10-18. Institutional configuration/approval remains
M1, live source adapters M3–M5, model approval M6 and final operational acceptance
M7. Fabian deferred final M2 acceptance/device tests; this does not turn synthetic
identities or successful compilation into institutional acceptance.

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
configuration revision and terminal operation fences. The Docker resolver checks
managed labels, exact image/release, isolation settings, loopback published port
and health before returning an endpoint. It rechecks the route before forwarding.

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

Final production topology, actual isolation/recovery, browser/assistive-technology
and institutional end-to-end qualification remain explicitly deferred/open.
