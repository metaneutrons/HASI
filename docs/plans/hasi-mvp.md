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

The [consolidated delivery plan](consolidated-delivery.md) is the unified
execution order for the issue graph and details the plugin-platform milestones,
including the MCP Apps feasibility gate. The
[issue-roadmap audit](../verification/2026-10-18/issue-roadmap-audit.md) maps the
35-issue source export and records the two later follow-ups #80 and #81 (37 issues
in the current tracking set). Neither document waives or replaces the
MVP criteria below; production Apps adoption remains disabled after the P2 no-go
decision.

## Current implementation slice

The prototype includes a validated server-owned model/provider registry,
explicit selection/fallback policy, a Groq connection and synthetic knowledge
fixtures. The current public demo runs on the Hetzner host under Coolify with
private PostgreSQL 18.6; the Vercel project and Neon database are retired. The
Coolify service still uses a preloaded image; exact-source CI builds and
automatic deployment remain open in [#79](https://github.com/metaneutrons/HASI/issues/79).
Local development runs separate plugin processes. The anny flow
uses synthetic data, including a 61-resource catalog snapshot: 37 workplaces,
6 meeting rooms and 18 office containers. The 43 bookable resources support
search, availability, own-booking lookup, and exact booking/cancellation
proposals with separate user confirmation. The actual anny HTTP client still
talks to a contract-based mock. Generic registry-driven chat discovery,
schema-driven configuration, personal account lifecycle, durable action
receipts and independent artifact/runtime composition are implemented. Final
M2 technical qualification is deferred; real institutional identity/source
contracts are M8 work. See the [implementation ledger](../verification/2026-10-18/m2-implementation.md).

The M3 candidate adds signed source-export ingestion, permission-aware hybrid
retrieval, incident expiry, source revisions, protected retained context and
reviewed MediaWiki/BlueSpice or HTML acquisition adapters; see the
[M3 implementation evidence](../verification/2026-10-18/m3-knowledge-pilot.md).
[PR #78](https://github.com/metaneutrons/HASI/pull/78) remains unmerged.
The synthetic HTML path is deployed from application commit `d05252f`; its
[verification record](../verification/2026-10-18/service-it-portal.md) covers
271 served Service-IT articles, MCP acquisition, source redirects and network
restrictions. The combined fixture inventory has 301 documents, including
30 Intranet fixtures. The 241 new Service-IT examples cover 183 authenticated
FAQ topics, one public RSS supplement, 22 services, eleven news items, nineteen
links and five forms. Category landings and five broken references are excluded.
Actual HsH source rights and server-side access are not approved. This evidence
supports technical M3 qualification only; remaining technical cases stay in #50.
At candidate `095f3c5`, hosted CI failed the existing cold-store reference-plugin
packaging test on both Node versions; #74 tracks that technical gate. Earlier
green CI at `1ffd651` is not evidence for the later candidate.

The user has set institutional acceptance as the final M8 milestone. M1–M7 may
close technical criteria using TestIdP, mock/reference authorities and synthetic
data. Approved institutional website acquisition, actual source ACLs and
incident freshness, real HsH SSO, Anny customer delegation and eligibility, live
booking/cancellation writes, protected-data processing, source-owner review and
recorded institutional go/no-go remain M8 requirements. Synthetic knowledge
fixtures and selectable mock personas do not establish institutional access
rights. M8 testing may use real systems only after its scope-specific operator
and institutional authorization; final recorded go/no-go follows that evidence.
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
DeepInfra with DeepSeek-V4.1-Flash is the requested next provider after the
synthetic Service-IT demo. Its provider/model contract and credential readiness
are unverified. Track the bounded addition in [#81](https://github.com/metaneutrons/HASI/issues/81) under
[DI-A1–DI-A4](model-provider-routing.md#deepinfra-follow-up), before the final M6
comparison; do not reopen accepted [#32–#34](https://github.com/metaneutrons/HASI/issues/32) or treat synthetic smoke results as protected-data approval.

## Delivery sequence and exit criteria

| Milestone | Technical work and qualification boundary | Technical evidence | Tracking |
| --- | --- | --- | --- |
| M1. Identity and integration contracts | Define interfaces, claims mapping, source/reference contracts and lifecycle states; exercise with TestIdP and mock authorities. Real institutional claims and grants transfer to M8. | Contract tests cover stable mock subjects, missing/duplicate/changed claims, denial and revocation signals. No transient identifier is treated as authority. | [#48](https://github.com/metaneutrons/HASI/issues/48) |
| M2. Application foundation | Web, API, worker and shared contracts in TypeScript; TestIdP session; trusted capability registry; constrained network/output handling; model-profile registry; logging; mobile-first UI shell. Cross-runtime, API/worker, performance and isolation qualification remains required; final device matrix is deferred. | Authenticated TestIdP flow; forged identities and unauthorized capabilities rejected; separate API/frontend deployment; API/worker and multi-instance behavior, performance, isolation and recovery qualify; model selection checked against full context and capability requirements. | [#49](https://github.com/metaneutrons/HASI/issues/49) |
| M3. Permission-aware knowledge qualification | Ingest/retrieve signed Intranet fixtures and reviewed synthetic HTML/web content; test language handling, source references, permission-aware context/caches and fixture incident freshness. No real source acquisition is required. | Curated German/English synthetic cases; two-user allow/deny and mocked rights revocation; no unauthorized fixture metadata/snippets reach models or users; citations, freshness fields and instructional-image extraction tested. | [#50](https://github.com/metaneutrons/HASI/issues/50) |
| M4. anny read contracts and behavior | Qualify account-link/read behavior against TestIdP and mock/reference anny contracts. | Different mock users see only permitted resources/bookings; conflicting, missing and duplicate mappings fail closed. No real customer rights are inferred. | [#51](https://github.com/metaneutrons/HASI/issues/51) |
| M5. anny write/cancel/reconcile behavior | Qualify server-bound proposals and action state against mock/reference contracts; do not issue live writes. | Customer eligibility rules represented in fixtures; stale/tampered confirmations rejected; retries are idempotent; cancellation and unknown-outcome reconciliation tested. | [#52](https://github.com/metaneutrons/HASI/issues/52) |
| M6. Synthetic model and adversarial evaluation | Formal offline evaluation with synthetic fixed evidence/workflows, injected sources/tool output, rendering, network and model-switch tests. | Security cases pass per profile; quality, citations, tool arguments, latency and measured cost compared; no protected context or production writes. Complete before M7; qualify BUD-A1 before paid runs. | [#53](https://github.com/metaneutrons/HASI/issues/53) |
| M7. Technical pilot and operations | Deliver all three technical mock integrations, pilot synthetic journeys and meet the agreed acceptance thresholds, then qualify actual-device UX and operations. Institutional data approval is not a prerequisite. | Key flows on real iPhone/Safari and Android/Chrome; connection-loss recovery, accessibility, encrypted-backup restore, off-host monitoring, incident procedures and rollback exercised. | [#54](https://github.com/metaneutrons/HASI/issues/54) |
| M8. Final institutional acceptance | Qualify real institutional identity, source permissions, Anny behavior, protected-data processing and accountable ownership after M1–M7 technical work. | All M8-A1–A6 evidence below and a recorded institutional go/no-go. No real writes or protected context before scoped authorization. | [#80](https://github.com/metaneutrons/HASI/issues/80) |

M1 contract design and offline M6 dataset/harness work can proceed in parallel.
Technical M3 and M4 require M1/M2 technical boundaries and may use #79's
qualified runtime where deployment evidence is relevant; they do not wait for
institutional grants. M5 follows M4. Formal M6 completes before M7, with BUD-A1
before paid runs and the bounded DeepInfra follow-up #81 before final provider
comparison. M7 uses synthetic data and preserves its real-device and
backup/restore requirements. M8 is the final institutional barrier; it does not
retroactively block technical milestones.

### Institutional acceptance (M8)

M8 #80 is the final institution-specific go/no-go. Scope-specific authorization
from the relevant operator and institutional owner precedes real-system tests;
the final recorded acceptance follows the evidence. The exact criteria are:

- **M8-A1 — Identity:** Real HsH identity, lifecycle and authorized claims are
  verified, including stable subject handling and account-link/revocation
  behavior.
- **M8-A2 — Sources:** Intranet and Service-IT source access, effective rights,
  revocation, freshness and source-owner review are qualified for both sources.
- **M8-A3 — Anny:** In the authorized tenant, actual customer delegation,
  eligibility, reads, create/cancel, idempotency and unknown-outcome
  reconciliation are verified.
- **M8-A4 — Data processing:** Protected-data processing, model/provider and
  embedding approvals, retention, and migration from demo boundaries are
  approved and tested.
- **M8-A5 — Owners and real cases:** Named institutional operating/integration
  owners review real source cases and approve any controlled participant test.
- **M8-A6 — Final authorization:** Evidence maps to the institutional contracts;
  denial, revocation and incident tests pass; accountable owners record the
  institutional go/no-go. Scope-specific operator and institutional
  authorization must precede each real write or protected-context test; final
  acceptance and rollout follow the evidence.

#### Transfer of the original M1–M7 institutional requirements

This transfer preserves the original acceptance scope. TestIdP, mocks and
synthetic fixtures demonstrate technical controls only; they do not waive real
institutional qualification.

| Original requirement | Technical milestone retained | Institutional qualification transferred to M8 |
| --- | --- | --- |
| M1: HsH IdP protocol, stable subject and lifecycle; source-specific contracts, effective rights/revocation; Anny organization, scopes, customer linking and eligibility | M1 contract schemas, TestIdP claim/lifecycle tests and mock source/Anny authorities | M8-A1 real identity; M8-A2 real source rights; M8-A3 actual Anny delegation and eligibility; M8-A5 named owners |
| M2: production SSO, approved provider profiles, security and data-processing boundaries | M2 technical session/capability/model-profile enforcement, budgets, logging and required CI qualification | M8-A1 real HsH claims; M8-A4 provider/embedding, retention and protected-data approvals |
| M3: approved real-source ingestion, source-user authorization, content/ACL freshness, owner review and real incident updates | M3 signed synthetic exports, reviewed HTML fixtures, retrieval/citations, mock allow/deny/revocation/freshness cases | M8-A2 real Intranet and Service-IT access/rights/freshness; M8-A5 source-reviewed real cases; M8-A6 denial/revocation/incident evidence |
| M4: real verified HsH-to-Anny account mapping and permitted customer reads | M4 TestIdP identities, mock mappings, permitted-resource and own-booking behaviors | M8-A1 real identity mapping; M8-A3 actual tenant delegation, eligibility and reads |
| M5: authorized real tenant writes, cancellation, idempotency and reconciliation | M5 proposal binding, confirmation, mock create/cancel/idempotency/unknown-outcome tests | M8-A3 actual create/cancel and vendor reconciliation in the authorized tenant; M8-A6 incident/denial evidence |
| M6: institutionally approved profiles/data classes and source-approved real evaluation cases | M6 formal synthetic/offline adversarial evaluation and measured provider comparison | M8-A4 protected-data/provider/embedding/retention approval; M8-A5 real reviewed cases; M8-A6 evidence-to-contract mapping |
| M7: all three integrations delivered; agreed acceptance thresholds met; controlled institutional participants, real integration owners and operational acceptance | M7 technical integrations against mocks, synthetic pilot, real-device UX, restore, off-host monitoring and incident/rollback exercises | M8-A1–A4 real integration and data approvals; M8-A5 named owners, real reviewed cases and controlled participant approval; M8-A6 recorded institutional go/no-go |
M2 tracks [plugin milestones P1–P6](consolidated-delivery.md#plugin-delivery-slices),
durable budgets (BUD-A1) and frontend findings (WEB-A1) in [#49](https://github.com/metaneutrons/HASI/issues/49).
The transferred Groq cache investigation (CACHE-A1) remains open within
[M6 #53](https://github.com/metaneutrons/HASI/issues/53); it does not establish
savings or complete M6. Former standalone issues #64–#67 are superseded, not
accepted; see the [successor mapping](consolidated-delivery.md#superseded-standalone-issues).


No duration or budget is asserted before operating constraints and team
availability are known. Technical read-only Anny behavior can be tested against
mock/reference contracts before write semantics are resolved; actual tenant reads
require their own M8 scope authorization.

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
- **Service-IT:** Direct website scraping is the currently available acquisition
  method. Which page/block access rules, complete inventory, update/deletion and
  incident freshness rules will be used? Who owns quality and change propagation?
- **Intranet:** Direct website scraping is the currently available acquisition
  method; Safari inspection identifies MediaWiki/BlueSpice. How are page,
  attachment and group-specific rights represented, checked and revoked? Who
  owns content and the access contract? An SSO login alone does not answer these
  authorization questions. No CMS export API is required; a HASI-operated
  acquisition process can produce the internal signed snapshot contract. See
  the [acquisition decision](../architecture/institutional-knowledge-operations.md#website-acquisition-decision-2026-10-18).
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

These are M8 institutional inputs. They do not block technical M1–M7 work against
TestIdP, mock/reference authorities and synthetic data.

## Current research status

Official anny Admin/Customer schemas and the public SSO evidence are saved. The
public Service-IT crawl found 104 unique HTML pages; this is historical public-
site research, not the current synthetic portal inventory. Authenticated research
captures and details remain local and are excluded from the public repository.
They do not establish a complete production knowledge index or access policy.
The completed synthetic fixture inventory is tracked separately above. Portal
deployment and runtime integration are separate qualification steps; the fixture
count alone is not a deployed count or an authoritative HsH source inventory.
An authoritative Intranet inventory, approved connector and access contract
remain unresolved as M8 institutional inputs; they do not block synthetic M3
qualification. Model registry/selection/fallback policy is implemented and
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
