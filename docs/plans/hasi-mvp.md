# hasi pilot plan

Created: 2026-10-09. Updated: 2026-10-18. Scope, mobile usability, TypeScript,
mock identity for the prototype and independently updateable plugins are agreed
requirements. The deployed synthetic-data prototype is an initial slice of the MVP.

Tracking: [institutional MVP epic #47](https://github.com/metaneutrons/HASI/issues/47)
and [post-MVP roadmap epic #55](https://github.com/metaneutrons/HASI/issues/55).
The plan owns scope, dependencies and acceptance criteria; linked issues own
current execution state, next actions, blockers and evidence. The separate
[delivery epic #14](https://github.com/metaneutrons/HASI/issues/14) owns demo and
container delivery, not institutional MVP acceptance.

The [consolidated delivery plan](consolidated-delivery.md) maps the
existing issues into a common dependency order and details the plugin-platform
milestones, including the MCP Apps feasibility gate. It does not waive or
replace the MVP criteria below; production Apps adoption still needs qualification.

## Current implementation slice

The prototype includes a validated server-owned model/provider registry,
explicit selection/fallback policy, a Groq connection and a synthetic knowledge
MCP with 60 fictional documents. Local development runs separate plugin
processes; the Vercel demo co-locates API/MCP entry points and persists workspace
state in Postgres. The anny flow
uses synthetic data, including a 61-resource catalog snapshot: 37 workplaces,
6 meeting rooms and 18 office containers. The 43 bookable resources support
search, availability, own-booking lookup, and exact booking/cancellation
proposals with separate user confirmation. The actual anny HTTP client still
talks to a contract-based mock. Production source contracts, generic third-party
chat tool discovery and generalized plugin configuration remain incomplete.

Real HsH SSO, production permission-aware retrieval from Intranet and
Service-IT, current IT incident information, authoritative anny customer and
resource mapping, production booking/cancellation writes, and verified
uncertain-outcome reconciliation remain open. Formal model evaluation and
institutional approval of profiles for protected data also remain open.
Synthetic knowledge fixtures and selectable mock personas do not establish
institutional access rights.
The current configuration and prototype work is partial. It does not complete
any milestone whose exit criteria include those capabilities. See
[prototype architecture](../architecture/plugins-and-prototype.md)
and the [README](../../README.md) for the executable scope and verification
commands.

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

| Milestone | Work | Evidence required to proceed | Tracking |
| --- | --- | --- | --- |
| M1. Integration contracts | Confirm identity protocol and stable subject; separate Intranet and Service-IT connectors, exports, access rules and revocation behavior; anny organization, region, token scopes, customer linking and eligibility behavior | Written contracts or verified sandbox behavior for each unresolved boundary; no account mapping based solely on a transient NameID; authoritative rights for both knowledge sources | [#48](https://github.com/metaneutrons/HASI/issues/48) |
| M2. Application foundation | Web, API, worker and shared contracts in TypeScript; SSO session; trusted capability registry; constrained network/output handling; approved model-profile registry; logging; mobile-first UI shell | Authenticated API flow; forged identities and unauthorized capabilities rejected; separate API/frontend deployment; usable mobile SSO and keyboard; model selection checked against full context and capability requirements | [#49](https://github.com/metaneutrons/HASI/issues/49) |
| M3. Intranet and Service-IT knowledge pilot | Approved ingestion for both sources, language handling, hybrid retrieval, source references, permission-aware context/caches and current IT incident updates | Curated German/English cases for both sources; no unauthorized source metadata/snippets reaching models or users; rights-revocation cases pass; attributable answers and fresh updates; extraction checks for instructional images | [#50](https://github.com/metaneutrons/HASI/issues/50) |
| M4. anny read operations | Link verified HsH identities to anny customers, search permitted resources, show availability and own bookings | Two users with different rights see correct results; conflicting, missing and duplicate account matches are handled explicitly | [#51](https://github.com/metaneutrons/HASI/issues/51) |
| M5. anny write operations | Server-bound action proposals, confirmation, create/cancel, reconciliation and webhook processing | Customer eligibility enforced; stale/tampered confirmations rejected; timeouts cannot silently duplicate bookings; cancellation affects only authorized bookings | [#52](https://github.com/metaneutrons/HASI/issues/52) |
| M6. Model comparison and adversarial evaluation | Tester model selector; fixed-evidence and workflow comparisons; injected sources/tool output; rendering, network and model-switch tests | Actual effects instrumented; mandatory security cases pass per profile; quality, citations, tool arguments, latency and costs compared; no production writes in comparison runs | [#53](https://github.com/metaneutrons/HASI/issues/53) |
| M7. Controlled pilot | Selected users, usage observations, answer/action review and operational handover | All three integrations delivered; agreed acceptance thresholds met; restore and incident procedures exercised; source/integration owners assigned; complete key flows verified on real iPhone/Safari and Android/Chrome, including connection loss and booking-state recovery | [#54](https://github.com/metaneutrons/HASI/issues/54) |

M1 contract discovery and offline M6 dataset/harness design can proceed in
parallel. Production acceptance of M3 and M4 requires the relevant M1 contracts
and M2 identity/policy foundation; M5 requires qualified M4 identities/rights and
M2 execution state. M6 institutional workflow qualification uses those integrated
boundaries. M7 requires all applicable M1–M6 gates. These are qualification
dependencies, not a prohibition on earlier synthetic fixtures or design work.
M2 tracks [plugin milestones P1–P6](consolidated-delivery.md#plugin-delivery-slices),
durable budgets (BUD-A1) and frontend findings (WEB-A1) in [#49](https://github.com/metaneutrons/HASI/issues/49).
The transferred Groq cache investigation (CACHE-A1) remains open within
[M6 #53](https://github.com/metaneutrons/HASI/issues/53); it does not establish
savings or complete M6. Former standalone issues #64–#67 are superseded, not
accepted; see the [successor mapping](consolidated-delivery.md#superseded-standalone-issues).


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
- **anny:** Confirm the production organization/region and supported customer
  context beyond the authorized catalog snapshot. Does admin booking enforce
  selected-customer restrictions, or is a delegated customer flow needed?
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
An authoritative Intranet inventory, approved connector and access contract
remain unresolved. Model registry/selection/fallback policy is implemented and
accepted in [#32–34](https://github.com/metaneutrons/HASI/issues/32). The prototype
has deterministic tool, confirmation, source-fixture and model-policy boundaries;
these are not a completed adversarial evaluation or production access contract.
Formal model/security qualification remains in M6.

See [technical basis](../architecture/technical-basis.md) and the linked
[Service-IT](../research/service-it.md), [anny](../research/anny-api.md) and
[identity](../research/hsh-identity.md) reports for evidence and limits.

## Future roadmap beyond the mandatory MVP

### Zammad topic-routed tickets

Tracking: [#56](https://github.com/metaneutrons/HASI/issues/56).

Zammad ticket creation is a proposed later integration for topic-routed support
requests across administrator-defined security domains. It does not defer or
replace the mandatory Intranet, Service-IT and anny integrations defined above.
The configurable taxonomy and routing, identity mapping, domain isolation,
approval requirements and acceptance gates are described in the
[Zammad MCP architecture](../architecture/zammad-mcp.md). No Zammad connector,
credentials or queue mappings are currently implemented or configured.

The integrations below are proposals for later, independently deployable MCP
plugins. They do not add mandatory sources to the MVP or change its acceptance
criteria. Microsoft 365 Bookings remains deferred. Each plugin must derive the
actor from HsH SSO and enforce source-side rights for that person. Read access
is limited to the authenticated person's records and permitted learning or
service data. The model cannot choose an account, identity, or authority. Every
write begins as a server-bound proposal that shows its exact target and effect;
execution requires the user's explicit confirmation and a fresh check of rights,
eligibility, deadlines, and current source state.

### Restricted public web search

Tracking: [#57](https://github.com/metaneutrons/HASI/issues/57).

Add a read-only MCP for public web discovery and reading within server-owned,
predefined URL scopes, including configurable anchored regex rules. A possible
scope is the HsH apex and its subdomains. Source restrictions must hold for
search-result metadata, document fetches, redirects, caches and crawler requests;
provider-side `site:` filters alone are insufficient. Public search cannot bypass
SSO/source permissions or replace protected Intranet/Service-IT adapters.

Evaluate Brave for a first external adapter and a TypeScript crawler plus local
index for an institution-controlled corpus. SearXNG is an optional metasearch
adapter, not an automatic university index. No service is commissioned or
connector implemented. See [restricted web search](../architecture/restricted-web-search.md)
for the provider comparison, URL/network policy and acceptance scenarios.

### Examination-regulations knowledge base for all degree programmes

Tracking: [#58](https://github.com/metaneutrons/HASI/issues/58).

Build a future, separately maintained knowledge corpus covering the complete
HsH degree-programme inventory. Its catalogue must show coverage and gaps for
every programme. Ingest authoritative, officially published general and
programme-specific examination regulations, amendments, relevant annexes and,
where needed, module handbooks. Record each document's authority and role so
supporting module information is not presented as a regulation.

For every document and provision, retain programme, degree, faculty, applicable
cohort, publication and effective dates, version history, and transition rules.
Never apply the newest amendment silently to students governed by an earlier
version. Authoritative PDFs are a required source format, including searchable
PDFs and scanned/image PDFs processed with OCR; HTML exports may supplement
them. Preserve each original file unchanged with its document hash and revision
metadata. For every PDF, map physical page numbers to printed page numbers where
present, and retain section, article and annex anchors. Validate reading order
for multi-column pages, tables and footnotes against rendered pages. Review
sample pages and critical extracted content before publishing an index. Quarantine
or flag low-quality extraction as unknown; never silently rely on it. Preserve
source access metadata and amendment applicability rather than flattening
amendments into one current text. If applicability is missing or ambiguous, ask
for clarification or abstain rather than infer a rule.

Every answer about a requirement must cite the exact document and version,
physical and printed page where available, section or annex, and a direct link
to the original reader page that respects the reader's permissions.
Applicability may use a student's HISinOne record only after a trusted SSO-to-
record link and the relevant access rights have been verified; mock identity or
persona selection is insufficient. The corpus supplies cited source material,
not invented legal facts or a binding eligibility decision. It does not replace
HISinOne's authoritative eligibility and exam-registration checks.

Acceptance requires a visible inventory of all programmes and uncovered
documents, and tested cases for scanned/image PDFs, digitally signed originals
preserved without editing, multi-column text, complex tables and cross-references,
exact page citations, old and new cohorts, amendments, overlapping transition
rules, and citation/version drift. Where the corpus cannot establish which rule
applies or extraction quality is insufficient, hasi must expose the uncertainty
and abstain from a substantive answer.

### Moodle LMS

Tracking: [#59](https://github.com/metaneutrons/HASI/issues/59).

Moodle's External Services framework documents web services for external
systems; the live site's enabled functions and API documentation are
instance-specific ([Moodle External Services](https://moodledev.io/docs/5.0/apis/subsystems/external)).

- **Read:** the authenticated student's courses, visible course materials,
  activities and deadlines, and submission or completion status where the
  instance exposes these fields and grants access.
- **Write proposal:** prepare an assignment response for the student to review.
  A later submission action may run only if the live instance documents and
  enables the relevant function. Show the exact course, activity and content,
  require confirmation, then recheck that the activity is open and the student
  remains authorized. No grade or administrative writes.

### Stud.IP learning and campus platform

Tracking: [#60](https://github.com/metaneutrons/HASI/issues/60).

Stud.IP documents a JSON:API-compatible REST interface with resource reads and
mutations; routes, available resources and permissions must be checked against
the HsH installation and its version ([Stud.IP JSON:API documentation](https://hilfe.studip.de/develop/Entwickler/JSONAPVueJSI)).

- **Read:** the authenticated person's courses, course dates, announcements
  and materials that the API exposes to that person.
- **Write proposal:** a course registration or a course contribution may be
  proposed only when the installed API exposes the operation and the source
  confirms eligibility. Show the exact course or contribution and its effect;
  require explicit confirmation and recheck registration rules, capacity and
  rights before execution.

### HISinOne campus management

Tracking: [#61](https://github.com/metaneutrons/HASI/issues/61).

HIS documents HISinOne functions for online exam and course registration,
student progress and results, and web services for connecting third-party
systems ([exams and courses](https://www.his.de/hisinone/pruefungen-und-veranstaltungen),
[HISinOne interfaces](https://www.his.de/hisinone/)). Those product descriptions
do not establish that HsH uses these modules or expose a specific HsH API for
exam-registration writes. Obtain the installed product/version, vendor or HsH
API contract, and permission model before committing to a connector or write
operation.

- **Read:** the authenticated student's own record and study history, grades,
  completed and current modules, exam dates and deadlines, and eligibility
  information only when returned by an authoritative HISinOne service. If the
  source does not provide a binding eligibility result, show the official
  record or link rather than infer eligibility from model context.
- **Write proposal:** exam registration is a high-impact action. Present the
  exact exam, term, date, applicable conditions and any consequences, require
  explicit confirmation, and recheck eligibility, deadline and existing
  registration immediately before submission. Execute only through a
  documented, HsH-authorized business API; otherwise direct the student to the
  authoritative HISinOne workflow.

### SAP personnel and time management

Tracking: [#62](https://github.com/metaneutrons/HASI/issues/62).

The SAP HANA estate alone does not identify a business application or a safe
API. SAP describes HANA as a database and platform; an application may enforce
the end-user permissions and workflows above that database ([SAP HANA overview](https://help.sap.com/docs/SAP_HANA_PLATFORM/eb3777d5495d46c5b2fa773206bbfb46/d3b1adcdbb571014a93eff11ad9a1d89.html)).
First identify the HsH system of record, product and configured workflow. SAP
SuccessFactors documents time-off and time-sheet APIs, but its use at HsH is
unknown ([EmployeeTime API](https://help.sap.com/docs/SAP_SUCCESSFACTORS_PLATFORM/d599f15995d348a1b45ba5603e2aba9b/a1905d4d4b26469b9ebca160ca34814c.html),
[Time Sheet API](https://help.sap.com/docs/successfactors-platform/sap-successfactors-api-reference-guide-odata-v2/time-sheet?locale=en-US));
these are candidate references only, not evidence of a deployed HsH service.

- **Read:** the authenticated employee's own leave balance and requests, time
  entries, clock events, service trips (`Dienstgang`) and associated time
  account, limited to records and fields authorized by the source application.
- **Write proposal:** prepare a vacation request, clock-in or clock-out event,
  or service trip (`Dienstgang`) only if the identified business application
  supports it. Show dates, times, duration,
  category and resulting effect; require explicit confirmation for each
  submission and recheck the employee's authority and current record. Never
  write directly to HANA tables or infer an application API from database
  access.

### Microsoft 365 Bookings IT appointments

Tracking: [#63](https://github.com/metaneutrons/HASI/issues/63).

HsH IT appointment booking uses Microsoft 365 Bookings; integration remains
explicitly deferred outside the mandatory MVP. Tenant/API permissions, service
ownership and the supported appointment workflow still require discovery.
This entry does not commit to an undocumented API or implement a connector.
If later approved, retain the shared identity, rights, exact-proposal and
confirmation boundaries for appointment writes.
