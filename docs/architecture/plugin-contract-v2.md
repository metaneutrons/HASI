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
MCP protocol `2026-07-28`. Compatible updates preserve configuration/identity,
tool schemas/effects/permissions/visibility and UI contracts. Contract changes
require renewed operator approval; an available version is not automatically
installed or activated. Old transcripts remain readable. Legacy pending
proposals without the current approval bindings are rejected and prepared again.

V2 adds optional `configuration`, logical `secrets`, `identity.claims`,
`presentations` and tool `visibility`, `presentationId`, `resultSemantics`.
Configuration is bounded JSON Schema with field labels/help/groups. Secret
declarations contain names and required flags, never values or custody references.
Remote schema references, prototype properties, cycles and unbounded structures
are rejected. The current form renders primitive, enum, integer and boolean
controls; nested/conditional forms need additional reviewed UI support and are
shown as unsupported rather than silently discarded.

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
Production execute handlers require a shared durable replay guard; a process-local
map is permitted only for local tests/development. Plugins never receive model
provider credentials or HASI session cookies.

Structured output must validate against its approved schema. Generic pagination
and provenance stay explicit schema fields; the host does not invent provenance
from free text. Existing Anny paging/filtering and knowledge citations use their
domain contracts. A richer mandatory cross-plugin pagination/provenance envelope
has not yet been qualified.

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
blindly retried. General authoritative reconciliation is still an integration
contract, not something a generic JSON result can establish.

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
The latter is not yet a complete generic OAuth account-linking UI. OIDC's test
provider proves the login boundary, not institutional account/role contracts.
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
public demo does not enable this feasibility flag. P2 go/no-go and actual mobile,
accessibility, navigation/network-negative and performance gates remain open.

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
| Vercel demo | Reviewed bundled fixtures and fixed HTTP transports | Cannot install persistent executable plugins inside a function |
| Approved remote MCP | Pinned manifest/endpoint and per-instance authority | Operator-reviewed adapter required for plain MCP without HASI policy/effect contract |
| Operator-local container driver | Verified signed digest image, nonroot/read-only/capability/resource/network policy, durable staged coordinator | Requires external atomic route controller, approved secret resolver and runtime qualification; no arbitrary pulls/build scripts |

The Docker controller is an operator-side component. Its Engine socket must never
be mounted into plugins or exposed to the public demo administrator. Release
envelopes use Ed25519 publisher approval and immutable image/manifest digests.
Independent external distribution, complete UI update review, production API/
worker deployment and actual-device qualification are not accepted by this code
alone. They remain tracked in M2/P5/P6.
