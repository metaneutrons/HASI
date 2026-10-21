# Plugin contract v2 and operator boundaries

Date: 2026-10-18. Implementation candidate for M2/P1–P6; qualification is
recorded separately. No institutional identity, external distribution or
native-phone acceptance is implied by the interfaces below.

## Identity and compatibility

| Identity | Owner and purpose |
| --- | --- |
| Package ID + version | Publisher; signed MCP audience and immutable contract |
| Installation ID | Operator; registry/configuration slot, collision-safe tool names |
| Configuration revision | Host; draft versus active public configuration and tool policy |
| Upstream tenant/account | Integration identity adapter; declared, minimized claims |
| Publisher/image/resource digest | Operator-reviewed artifact/UI identity, independently of endpoint reachability |
| Credential revision | Operator-supplied rotation/deployment marker; never derived from a secret value |

V1 contracts retain their original manifest shape/digest. Their compatibility
adapters keep the existing Anny identity and knowledge audience behavior.
Additional installation IDs require v2: v1 cannot distinguish installation
audiences. V2 uses `manifestVersion: 2`, `apiVersion: "2.0.0"`, and the existing
MCP protocol `2026-07-28` by default. The optional
[invocation-scoped managed state profile](managed-plugin-state.md) explicitly
pins a bidirectional sessionful transport; it does not change other plugins.
Compatible updates preserve configuration/identity/state declarations,
tool schemas/effects/permissions/visibility and UI contracts. Contract changes
require renewed operator approval; an available version is not automatically
installed or activated. Old transcripts remain readable. Legacy pending
proposals without the current approval bindings are rejected and prepared again.

V2 adds optional `configuration`, logical `secrets`, `identity.claims`,
`presentations` and tool `visibility`, `presentationId`, `resultSemantics`.
Configuration is bounded JSON Schema with field labels/help/groups. Secret
declarations contain names and required flags, never values or custody references.
Remote schema references, prototype properties, cycles and unbounded structures
are rejected. The form supports bounded nested objects/arrays, primitive and enum fields,
conditional if/then/else rules and uniquely discriminated oneOf/anyOf branches.
Unsupported schema rules are reported explicitly and retain stored values;
ambiguous branches are never guessed. JSON Pointer diagnostics map to fields.
Rendering is capped independently of schema validation.

## Discovery, calls and results

The authenticated core exposes only installed, enabled, configured tools whose
permissions the current actor holds. Execute tools are host-only. Omitted
visibility means model-only; app invocation requires explicit app visibility and
a read effect. Visibility grants no authority. Model names are
`hasi_` plus the first 24 SHA-256 hex characters of `installationId + NUL + name`.
The exact default Anny/knowledge installations retain optimized aliases/cards;
other installations use the same generic discovery/call path.

The chat server fetches descriptors from its fixed authenticated core destination.
It checks hashes, schemas and size limits again. Browsers cannot submit tool
schemas, secret references or origins. A turn has at most 32 model tools and
32 KiB of serialized definitions. Generic results use bounded plain text/JSON;
descriptions and output remain untrusted data. They do not render arbitrary HTML
or load external images. Invalid/removed tools cannot become model capabilities
through persisted client history. Existing domain wrappers retain source readers,
citations, compact room cards and interval checks.

Calls use the authenticated session's subject and permissions. The host projects
only declared v2 claims and relevant tool permissions, then signs package/version,
tool, argument hash, installation, active configuration/revision, expiry and a
single-use identifier. Upstream identities are plugin-specific:
`anny.customerId` and `anny.resourceIds` belong to its adapter, not every plugin.
Production execute handlers require a shared durable replay guard and execution
journal; process-local stores are permitted only for local tests/development. Plugins never receive model
provider credentials or HASI session cookies.

Structured output must validate against its approved schema. Generic pagination
and provenance stay explicit schema fields; the host does not invent provenance
from free text. Existing Anny paging/filtering and knowledge citations use their
domain contracts. Production registry composition adds a mandatory host-owned `_hasi` envelope
with installation/manifest/configuration, authorization digest, operator source
classification/revision, fetch time and explicit pagination. Plugin-supplied
`_hasi` is rejected. Legacy v1 callers can use explicit compatibility mode.
Unpaged completeness describes this tool result, not a complete institution-wide
inventory; paged adapters must supply reviewed cursor/completeness semantics.
Final cross-plugin acceptance tests remain pending.

## Host-owned confirmation

Prepare tools return a draft with `executionTool`, exact `arguments` and
`resourceName`. The host verifies an approved execute counterpart and permissions,
then stores an expiring immutable proposal. Generic confirmation shows the
installation, action, target and all arguments; Anny retains its purpose-built
date/room preview. A view or model cannot confirm. Executions are never exposed
as model-callable functions.

The proposal binds subject, projected account/authority, manifest, configuration,
enabled state, endpoint and operator credential revision. Confirmation rechecks
the binding and passes it into invocation, which checks before signing and again
after connecting. Activation, account changes, removal and endpoint changes make
old proposals stale. CAS permits one claimant; repeated confirmation returns the
recorded outcome. An uncertain external outcome remains uncertain and cannot be
blindly retried. Signed SDK receipt reads reconcile committed outcomes without
executing again. Source-specific status adapters must resolve a crash between an
upstream write and receipt commit; a generic JSON result cannot establish failure.

## Administrator journey

1. **Connect:** choose from an operator-owned catalogue. The browser sends only
   the approved source ID. It cannot install arbitrary repository code, choose a
   network address or assign a secret. Unapproved sources are denied.
2. **Configure:** schema labels/help explain public fields. Credential slots show
   required/configured status only; operators provision/rotate values outside chat.
   Missing slots or invalid configuration leave the service not ready.
3. **Save draft:** revision-controlled validation preserves active behavior.
   A stale save returns 409; reloading is explicit and preserves unsaved input.
4. **Activate:** a separate action changes active configuration/tool policy and
   invalidates incompatible pending approvals. Audit records include subject,
   operation and time. Reachability, configuration readiness and user authority
   are distinct states.
5. **Update/recover:** review publisher/manifest/image, permissions/effects,
   network/UI changes and migrations. Stage before activation; failed preflight
   leaves the active release intact. Unknown activation requires reconciliation.
   Rollback rechecks current publisher/credential/grant approval and compatible
   state. An irreversible migration requires a restore/forward recovery plan.
6. **Disable/remove:** disabling stops calls but retains the installation.
   Removing a catalogue connection prevents stale replicas from re-enabling it;
   history/configuration remain, and existing bookings are not silently cancelled.

Central service setup is separate from personal account consent/renewal/revocation.
Personal connections have a separate consent/renewal/disconnect UI and a
subject-bound callback. Trusted operator adapters supply provider authorization,
credential custody and fresh rights. OIDC's test provider proves the login
boundary, not institutional account/role contracts.
The production identity adapter must supply current authority, rather than
treating a historical login claim as permanent permission.

End users keep their conversation/draft in browser storage. On denial the UI must
explain the missing permission; stale actions require a new preview, unavailable
services can be retried, and unknown outcomes require status inspection. Generic
reauthentication return-to-task and personal consent flows remain qualification
work; a fixed login redirect is not evidence that every interrupted task resumes.

## MCP Apps feasibility and restrictions

The opt-in Anny v2 view uses official `@modelcontextprotocol/ext-apps` **2.0.3**
with the workspace MCP **2.3.1** packages. A deterministic build embeds the pinned
browser SDK and its upstream notice. The packaged HTML is hash checked both by
the registry and browser. Default v1 and native cards remain available.

The host supplies theme, locale, Europe/Berlin, dimensions and touch context.
The iframe has `sandbox="allow-scripts"` without same-origin or navigation/popup
permissions; injected CSP restricts resource/connect/form/frame/object channels.
The bridge checks the source window, allowed methods/tools, payload bounds and
timeouts. It denies arbitrary messages, model-context updates, links and execute
calls. Filtering/paging must never trigger another model generation.

**A sandboxed scripted iframe is not a general hostile-code network firewall.**
Browser CSP does not reliably prohibit all self-navigation channels. Therefore a
manifest hash alone does not activate a view: `reviewedAppDigests` is a separate
operator-owned allowlist of reviewed immutable UI code. The local switch approves
only the bundled Anny view. Unreviewed third-party Apps remain denied. The
public demo does not enable this feasibility flag. The implementation decision
is native results by default and no-go for unreviewed third-party Apps. Actual
mobile, accessibility, navigation/network-negative and performance qualification
remains open before broader adoption.

The local launcher supplies the reviewed resource hash as
`HASI_REVIEWED_APP_DIGEST` to the prototype API. App mode fails closed when that
operator-owned value is absent or malformed. The generic API package does not
import the Anny implementation to choose its own UI approval.

Local feasibility stack after building backend declarations:

```sh
pnpm exec tsx scripts/dev.ts --test-idp --plugin-apps
```

This starts an actual loopback OIDC IdP with PKCE/state/nonce and signed ID tokens;
no institutional password is requested. Local keys, sessions and grants are
synthetic. The IdP rejects non-test mode.

## Deployment/runtime matrix

| Runtime | Supported boundary | Qualification limit |
| --- | --- | --- |
| Local reference stack | Separate web/API/MCP processes; test IdP | Memory state, synthetic identities |
| Coolify public demo | Reviewed composition, persistent PostgreSQL and fixed approved transports | Public administrators cannot install arbitrary executables or access Docker |
| Vercel | Retired; not an execution or secret-storage target | No current deployment support |
| Approved remote MCP | Pinned manifest/endpoint and per-instance authority | Operator-reviewed adapter required for plain MCP without HASI policy/effect contract |
| Operator-local container driver | Verified signed digest image, nonroot/read-only/capability/resource/network policy, durable staged coordinator | Shared CAS route controller, configuration binding, verified endpoint gateway and operator secret custody implemented; actual runtime qualification pending; no arbitrary pulls/build scripts |

The Docker controller is an operator-side component. Its Engine socket must never
be mounted into plugins or exposed to the public demo administrator. Release
envelopes use Ed25519 publisher approval and immutable image/manifest digests,
with [authenticated source and license inventory](plugin-release-provenance.md)
bound to the built image label before container creation or secret resolution.
Independent external distribution, complete UI update review, production API/
worker deployment and actual-device qualification are not accepted by this code
alone. They remain tracked in M2/P5/P6.


## Implementation completion and deferred acceptance (2026-10-18)

Fabian requested completion of M2 implementation while deferring final tests.
Personal account services are installed by the operator per installation and
use trusted adapters for credential custody and fresh rights projection. The
model/browser never supplies an upstream account. Consent state is subject-,
installation- and revision-bound; renewal/disconnect/revocation invalidates old
approvals. Only the synthetic runtime accepts its local test-consent screen.
The production account service rejects demo adapters.

Execution tokens can carry a host-generated `executionId`. SDK `ExecutionJournal`
records the attempt before the side effect and stores a validated result before
returning it. A signed, host-only `/hasi/actions/status` request reads that
receipt. `POST /api/proposals/:id/reconcile` never invokes the execute tool; it
requires current subject/account/configuration authority and a matching receipt
or reviewed source-specific status adapter. Missing, incomplete or unreachable
receipts remain unknown. A crash between an upstream write and receipt commit
requires source-specific reconciliation (M5); no timeout or empty read proves
that a write failed. Do not expire idempotency tombstones while replay remains
possible.

The trusted host preview includes service instance, account, exact target and
arguments, effect, consequences and costs. Production rejects preparation without
a reviewed action policy. Changes to that policy invalidate previous approvals.
Historical cards do not execute by rendering; users can explicitly request a
status check. See [production composition](production-runtime.md) and
[operations](plugin-operations.md). Final device/security/recovery qualification
and institutional rights approval are not claimed by implementation alone.
