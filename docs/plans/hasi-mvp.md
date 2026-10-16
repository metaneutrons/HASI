# hasi pilot plan

Created: 2026-10-09. Updated: 2026-10-16. Scope, mobile usability, TypeScript,
mock identity for the prototype and independently updateable plugins are agreed
requirements. The local implementation is an initial slice of the MVP.

## Current implementation slice

The local prototype implements server-owned test identities, a shared user/admin
interface with light/dark/system themes, an MCP plugin SDK and separate anny
plugin process. The actual anny HTTP client talks to a contract-based mock.
Room search, availability, own-booking lookup and exact-proposal confirmation
work with synthetic data. Runtime registry activation supports compatible
plugin versions independently of a core rebuild.

Real SSO, source connectors, permission-aware knowledge retrieval, model
integration/evaluation, authoritative anny mapping, cancellation, persistence
and uncertain-outcome reconciliation remain open. This prototype therefore does
not complete any milestone whose exit criteria include those capabilities.
See [prototype architecture](../architecture/plugins-and-prototype.md) and the
[README](../../README.md) for the executable scope and verification commands.

## Product scope

hasi helps students, staff and professors find applicable HsH IT guidance and
use institutional services through their existing HsH identity. The following
three integrations are mandatory for the MVP:

| Integration | Required MVP behavior |
| --- | --- |
| `intranet.hs-hannover.de` | Knowledge search and attributable answers with source citations, enforcing the requesting user's source access rights |
| `service.it.hs-hannover.de` | Knowledge search and attributable answers with source citations, enforcing the requesting user's source access rights, plus current IT incident information |
| anny | Permitted room search, availability, own-booking lookup, booking and cancellation after exact user confirmation |

The Intranet connector and access contract still require investigation. This
does not make Intranet support optional or move it to a later release. Earlier
partial prototypes must be identified as incomplete against the MVP scope.
Microsoft 365 Bookings and further integrations are deferred.

The chat is one interaction surface. Room results, proposed actions and
confirmation controls are structured UI components, also usable by a later
smartphone app through the shared application API.

Responsive behavior and complete mobile usability are required for the first
release. The mobile acceptance criteria in the
[technical basis](../architecture/technical-basis.md#mobile-experience-and-acceptance)
apply to every milestone with a user-facing flow.

The agreed production application language is TypeScript across frontend, API,
integration plugins and background workers. Local research utilities are
outside the deployed application.

Authorized testers must be able to select approved provider/model profiles and
run reproducible comparisons. Backend authorization, action confirmation and
data-processing eligibility remain invariant across models. Prompt injection
defenses and their acceptance scenarios are part of the MVP; see
[security and model evaluation](../architecture/security-and-models.md).
The [first benchmark plan](../evaluation/benchmark-v1.md) proposes five current
candidate profiles, a 200-case curated dataset and blinded comparison criteria.

## Delivery sequence and exit criteria

| Milestone | Work | Evidence required to proceed |
| --- | --- | --- |
| 1. Integration contracts | Confirm identity protocol and stable subject; separate Intranet and Service-IT connectors, exports, access rules and revocation behavior; anny organization, region, token scopes, customer linking and eligibility behavior | Written contracts or verified sandbox behavior for each unresolved boundary; no account mapping based solely on a transient NameID; authoritative rights for both knowledge sources |
| 2. Application foundation | Web, API, worker and shared contracts in TypeScript; SSO session; trusted capability registry; constrained network/output handling; approved model-profile registry; logging; mobile-first UI shell | Authenticated API flow; forged identities and unauthorized capabilities rejected; separate API/frontend deployment; usable mobile SSO and keyboard; model selection checked against full context and capability requirements |
| 3. Intranet and Service-IT knowledge pilot | Approved ingestion for both sources, language handling, hybrid retrieval, source references, permission-aware context/caches and current IT incident updates | Curated German/English cases for both sources; no unauthorized source metadata/snippets reaching models or users; rights-revocation cases pass; attributable answers and fresh updates; extraction checks for instructional images |
| 4. anny read operations | Link verified HsH identities to anny customers, search permitted resources, show availability and own bookings | Two users with different rights see correct results; conflicting, missing and duplicate account matches are handled explicitly |
| 5. anny write operations | Server-bound action proposals, confirmation, create/cancel, reconciliation and webhook processing | Customer eligibility enforced; stale/tampered confirmations rejected; timeouts cannot silently duplicate bookings; cancellation affects only authorized bookings |
| 6. Model comparison and adversarial evaluation | Tester model selector; fixed-evidence and workflow comparisons; injected sources/tool output; rendering, network and model-switch tests | Actual effects instrumented; mandatory security cases pass per profile; quality, citations, tool arguments, latency and costs compared; no production writes in comparison runs |
| 7. Controlled pilot | Selected users, usage observations, answer/action review and operational handover | All three integrations delivered; agreed acceptance thresholds met; restore and incident procedures exercised; source/integration owners assigned; complete key flows verified on real iPhone/Safari and Android/Chrome, including connection loss and booking-state recovery |

No duration or budget is asserted before operating constraints and team
availability are known. A read-only anny pilot can begin before write semantics
are resolved, provided resource visibility is enforced.

## Initial capability contract

| Plugin | Capability | Output or side effect |
| --- | --- | --- |
| Service-IT | `service_it.search` | Authorized excerpts, source URL, language, revision/fetch time and relevance |
| Intranet | `intranet.search` | Authorized excerpts and backend-issued source references, language, revision/fetch time and relevance; titles/previews/citations follow the same rights |
| anny | `anny.search_resources` | Resources visible and applicable to the authenticated user |
| anny | `anny.get_availability` | Resource/service identifiers and validated time intervals |
| anny | `anny.list_my_bookings` | Bookings that the authenticated user is entitled to see |
| anny | `anny.propose_booking` | Expiring server-side proposal, with room, time, applicable terms and any costs |
| anny | `anny.propose_cancellation` | Expiring proposal with booking and cancellation consequences |

Execution occurs through an authenticated confirmation endpoint rather than a
model-generated confirmation claim. The backend derives actor and tenant;
the model cannot supply a customer ID as authority. Re-check eligibility and
availability on execution. Confirmation binds the exact proposal and cannot
silently change room, time or consequences.

## Decisions still required

- **HsH identity:** Which existing SAML/OIDC integration is supported for hasi?
  Which stable subject and role/affiliation claims will be released?
- **Service-IT:** Can Wagtail provide a versioned export with authoritative
  access rules at the appropriate page or block scope? Who owns source quality
  and change propagation? The current research capture covers one account.
- **Intranet:** Which platform and approved connector/export are available?
  How are page, attachment and group-specific rights represented, checked and
  revoked? Who owns content and the access contract? An SSO login alone does
  not answer these authorization questions.
- **anny:** Which organization and API region does HsH use? Does admin booking
  enforce selected-customer restrictions, or is a customer-context flow needed?
  What is the authoritative customer-linking and uncertain-outcome mechanism?
- **Models and operation:** Which profiles/endpoints are approved for which
  data classifications, and who can select them? Which institutional hosting,
  embedding endpoint, retention rules and evaluation thresholds apply? Flexible
  model selection is required; the particular models remain to be evaluated.
- **Delivery:** Who implements and operates the TypeScript stack? Existing
  institutional expertise may justify changing the proposed framework choices.

## Current research status

Official anny Admin/Customer schemas and the public SSO evidence are saved. The
public Service-IT crawl found 104 unique HTML pages. Authenticated research
captures and details remain local and are excluded from the public repository.
They do not establish a complete production knowledge index or access policy.
The Intranet platform, source inventory and access contract have not yet been
investigated. Prompt injection controls and model switching are documented
requirements and designs, not implemented functionality.

See [technical basis](../architecture/technical-basis.md) and the linked
[Service-IT](../research/service-it.md), [anny](../research/anny-api.md) and
[identity](../research/hsh-identity.md) reports for evidence and limits.
