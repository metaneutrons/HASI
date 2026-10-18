# HASI consolidated delivery plan

Plan version: 3. Adopted 2026-10-18. This version keeps the accepted v2
execution order and acceptance requirements, and consolidates their GitHub
tracking into a 13-open-issue target. The issue graph and requirements originate
from the baseline adopted against main
`a03fdf2049c99a287397705e1e34b9761c2b2430`.

Decision state: **v3 changes issue granularity only.** The user approved the
13-open-issue structure on 2026-10-18. It does not change product scope,
acceptance authority, implementation state or evidence, and it does not mark
work accepted. Until each successor issue contains the transferred status,
next action and evidence, the source issue remains open and authoritative.
Transferred source issues close with GitHub's `not_planned` reason, never as
completed work. The original planning baseline was adopted by the user on
2026-10-18. Third-party MCP Apps remain off by default after the P2 no-go
decision; contracts and executable-code admission retain their review gates.
This plan does not
authorize live writes, new paid resources, a container release or execution of
third-party code.

## Purpose and authority

Keep one executable dependency order without creating another backlog. HASI
remains a chat-first, mobile-first university assistant. Intranet, Service-IT
and anny remain mandatory for the institutional MVP. V3 consolidates the open
tracking records as follows: #47 is the unified delivery index, #49 owns M2 and
the six P1–P6 qualification groups, and #55 retains all eight post-MVP
proposals. Existing evidence and criteria move with their status; only the
number of issue records changes.

This document owns the cross-track sequence and the detailed plugin
delivery slices. It complements these existing requirements authorities:

- [MVP plan](hasi-mvp.md): product scope, technical M1–M7 acceptance, final M8 institutional acceptance and later integrations.
- [Plugin architecture](../architecture/plugins-and-prototype.md#external-installation-and-administrator-configuration): installation, configuration and trust boundaries.
- [Delivery plan](releases-and-demo.md): D1/D2 historical Vercel acceptance,
  current Coolify delivery follow-up #79, and separate Release Please D3.
- [Model benchmark](../evaluation/benchmark-v1.md), [credential and budget boundary](../architecture/llm-router-credentials.md) and [repository findings](../architecture/repository-standard.md#known-doctor-findings-2026-10-16): evaluation, spending controls and engineering gaps.
- [Issue roadmap audit](../verification/2026-10-18/issue-roadmap-audit.md):
  all-issue status map and transfer record; GitHub issues remain the current
  execution-state authority.

Those requirements are not weakened or duplicated here. Issues own current stage,
next action, blockers and evidence. The tables below map work and dependencies;
they are not live completion tables. A reviewed change must settle conflicts
before implementation; an issue edit cannot waive an existing requirement.

## Current baseline — 2026-10-18

The current public demo runs on the Hetzner host under Coolify. HASI, the demo
wiki and private PostgreSQL 18.6 are managed there; the Vercel project and Neon
database have been retired. The Coolify service still uses a preloaded image.
CI-qualified source builds and deployment to this host are open in [#79](https://github.com/metaneutrons/HASI/issues/79). The cutover and database
records are in [self-host verification](../verification/2026-10-18/selfhost-cutover.md)
and [PostgreSQL cutover verification](../verification/2026-10-18/local-postgres-cutover.md).

M2 and P1–P6 implementation is merged, but final technical acceptance is
deliberately deferred. [PR #78](https://github.com/metaneutrons/HASI/pull/78) is
unmerged. Earlier green CI at `1ffd651` is historical; candidate `095f3c5`
failed the existing cold-store reference-plugin packaging test on both Node
versions (tracked in #74). M1–M7 now qualify technical behavior against TestIdP, mock/reference
authorities and synthetic fixtures. Real institutional identity, source rights,
Anny tenant behavior, protected-data approval and final go/no-go are reserved for
M8 [#80](https://github.com/metaneutrons/HASI/issues/80); mock evidence does not
qualify that milestone.

The failed offline reference-plugin packaging check is a bounded repair in the
PR #78 candidate and remains separate from full P6 qualification. The current
repair explicitly prepares dependencies online, then builds the package with
the frozen lockfile in offline mode; local verification also denies all network
access. It reports fixed sanitized
error categories and does not bypass lockfile enforcement. [Local verification](../verification/2026-10-18/reference-plugin-offline.md)
records that repair evidence; PR #78 still needs exact-head CI before merge. A
passing package check resolves this reported blocker only, not P6-A1–A4.

The synthetic Service-IT HTML path is deployed from application commit
`d05252f`; [the verification record](../verification/2026-10-18/service-it-portal.md)
covers 271 served Service-IT articles, signed MCP acquisition and network
restrictions. The combined fixture inventory has 301 documents (271 Service-IT,
30 Intranet), including 241 newly inventoried synthetic examples. Intranet chat
retrieval remains on fixtures. The older 60-document seed and 104-page public
crawl are separate historical evidence. Synthetic content and mock identity
support technical M3/M4 qualification; they do not establish HsH rights or
complete all remaining technical cases.

The accepted model registry/routing work in #32–#34 is reused. DeepInfra with
DeepSeek-V4.1-Flash is the requested next provider after the synthetic
Service-IT demo; provider contract, model compatibility and credential
readiness remain unverified. Track this bounded additive work in [#81](https://github.com/metaneutrons/HASI/issues/81) against
[DI-A1–DI-A4](model-provider-routing.md#deepinfra-follow-up), before final M6
comparison, without reopening accepted #32–#34. Real SSO, source ACLs, delegated
anny rights, live writes and institutional model approval remain M8 criteria.

## V3 issue graph

The target contains 13 open issues: #17, #47–#55, and #79–#81. #47 indexes the
technical M1–M7 milestones, final institutional M8, and the related D1–D3,
Coolify and provider tracks. #49 owns M2 plus the six separately evidenced P1–P6
qualification groups. #55 retains all eight future integration proposals and
their source-specific discovery gates. P1–P6, M1–M8, D3, #79, #81 and the future
roadmap remain unaccepted until their own gates pass.

GitHub remains the live status authority during the transfer. Do not close a
source issue until its successor body links the original issue and preserves
its stage, next action, blockers, criterion IDs and complete evidence
references. The transferred issues close with GitHub's `not_planned` reason,
never as completed work. All 37 issue records and their histories remain.

| Target issue | Responsibility and acceptance authority | Prerequisite or qualification boundary |
| --- | --- | --- |
| [#47](https://github.com/metaneutrons/HASI/issues/47) | Unified delivery index; MVP and delivery plans | Indexes M1–M7 and final M8, D1/D2 history, open D3 #17, current Coolify #79, provider #81 and post-MVP #55 |
| [#48](https://github.com/metaneutrons/HASI/issues/48) | M1 technical identity/integration contracts | TestIdP, mock authorities and stable interface contracts; real institutional proof transfers to M8 |
| [#49](https://github.com/metaneutrons/HASI/issues/49) | M2 technical application and plugin foundation | TestIdP/mock contracts; owns P1–P6 as separate P*-A* qualification groups plus BUD-A1 and WEB-A1; final tests remain deferred |
| [#50](https://github.com/metaneutrons/HASI/issues/50) | M3 synthetic permission-aware knowledge qualification | M1/M2 technical boundaries and signed fixtures for Intranet and HTML/web acquisition; source rights remain M8 |
| [#51](https://github.com/metaneutrons/HASI/issues/51) | M4 anny read contracts and behavior | M1/M2 technical boundaries; mock identities and reference contracts, not a real tenant |
| [#52](https://github.com/metaneutrons/HASI/issues/52) | M5 confirmed anny write/cancel/reconcile behavior | Follows M4 against mocks/reference contracts; actual tenant and vendor conformance remain M8 |
| [#53](https://github.com/metaneutrons/HASI/issues/53) | M6 synthetic/offline model and adversarial evaluation | Formal evaluation before M7; BUD-A1 before paid runs; DI-A1–DI-A4 via #81 before final provider comparison; CACHE-A1 remains separate |
| [#54](https://github.com/metaneutrons/HASI/issues/54) | M7 synthetic technical pilot and operations | M1–M6 technical gates, real-device UX, restore and off-host monitoring; no institutional data prerequisite |
| [#55](https://github.com/metaneutrons/HASI/issues/55) | Post-MVP roadmap and discovery register | Retains eight scoped proposals, source-specific next actions and reactivation gates; no connector is committed or implemented |
| [#80](https://github.com/metaneutrons/HASI/issues/80) | M8 final institutional acceptance | After M1–M7; real identity, source rights, Anny tenant, protected-data approval and recorded go/no-go |
| [#17](https://github.com/metaneutrons/HASI/issues/17) | D3 first actual container publication | Separately requested Release Please release; exact-tag amd64/arm64 and real publication evidence |
| [#79](https://github.com/metaneutrons/HASI/issues/79) | CI-qualified source deployment to Coolify | Exact main SHA, state/budget preservation, authenticated trigger, health checks and rollback |
| [#81](https://github.com/metaneutrons/HASI/issues/81) | Bounded DeepInfra/DeepSeek-V4.1-Flash follow-up | After synthetic Service-IT; DI-A1–DI-A4; additive to #32–#34 and before final M6 comparison |

### Issue transfer and evidence preservation

| Source issue | Successor | Transfer scope; closure does not signify acceptance |
| --- | --- | --- |
| [#14](https://github.com/metaneutrons/HASI/issues/14) | #47 | Preserve D1/D2 acceptance history via #15/#16, keep D3 #17 open, and carry #79 and #81 pointers forward. Close as `not_planned` only after #47 and the delivery plan link all successors. |
| [#69](https://github.com/metaneutrons/HASI/issues/69) | #49 · P1 | Preserve P1-A1–A4, merged implementation status, cross-contract/journey next action and PR/CI evidence. Qualification remains open. |
| [#70](https://github.com/metaneutrons/HASI/issues/70) | #49 · P2 | Preserve P2-A1–A4, native-results default, Apps-off/no-go decision, security/navigation/egress, accessibility, mobile and latency/token comparisons. Qualification remains open. |
| [#71](https://github.com/metaneutrons/HASI/issues/71) | #49 · P3 | Preserve P3-A1–A4, merged implementation and adversarial/model-switch/Apps-off/removal/history/deployed-topology next action with PR/CI evidence. Qualification remains open. |
| [#72](https://github.com/metaneutrons/HASI/issues/72) | #49 · P4 | Preserve P4-A1–A4, merged implementation and actual-device, assistive-technology, reconnect, update and personal-account next action with PR/CI evidence. Qualification remains open. |
| [#73](https://github.com/metaneutrons/HASI/issues/73) | #49 · P5 | Preserve P5-A1–A5, merged implementation and immutable-image isolation/egress, multi-replica, migration, UI preflight and recovery next action with PR/CI evidence. Qualification remains open. |
| [#74](https://github.com/metaneutrons/HASI/issues/74) | #49 · P6 | Preserve P6-A1–A4, merged implementation and full mobile, accessibility, hostile-result, cold-cache and lost-connection/recovery matrix. Carry the active PR #78 offline-packaging repair and CI 39166943626 failure as a separate open blocker; passing that packaging repair alone does not qualify P6. |
| [#56–#63](https://github.com/metaneutrons/HASI/issues/56) | #55 | Preserve all eight capabilities, discovery actions, capability boundaries and reactivation conditions inline in the corresponding MVP roadmap sections. No separate child issue is reopened until work is selected. |

The 15 source issues (#14, #56–#63 and #69–#74) close as `not_planned` only
after complete status/evidence transfer and successor readback. Keep #17, #47–55
and #79–81 open until their own gates pass. Keep the previous nine closed issue
records and their closure reasons unchanged. The target is 13 open and 24
closed issue records; no criteria or acceptance status changes.

### Previously superseded issues

| Former issue | Successor | Existing transfer and status |
| --- | --- | --- |
| [#65](https://github.com/metaneutrons/HASI/issues/65) | #49 (P1–P6 groups) | Already closed as not planned; installation, UX, isolation and independent updates remain unaccepted. |
| [#66](https://github.com/metaneutrons/HASI/issues/66) | #49, BUD-A1 | Already closed as not planned; budget reservations/accounting remain open. |
| [#67](https://github.com/metaneutrons/HASI/issues/67) | #49, WEB-A1 | Already closed as not planned; engineering gaps remain open unless resolved or explicitly excepted. |
| [#64](https://github.com/metaneutrons/HASI/issues/64) | #53, CACHE-A1 | Already closed as not planned; cache hit remains unproven and measurement obligations remain open. |

## Unified delivery order and parallel work

```mermaid
flowchart TD
    M1[M1: technical identity and interface contracts] --> M2[M2: technical application foundation]
    P[P1-P6: plugin delivery] --> M2
    B[Durable budgets and frontend findings] --> M2
    M2 --> D79[#79: source-qualified Coolify deployment]
    M1 --> M3[M3: synthetic knowledge qualification]
    M1 --> M4[M4: mock/reference Anny reads]
    D79 --> M3
    D79 --> M4
    M4 --> M5[M5: mock/reference writes and reconciliation]
    M2 --> M5
    E[Offline dataset and harness design] --> M6[M6: synthetic/offline model evaluation]
    SI[Synthetic Service-IT demo] --> DI[#81: DeepInfra candidate profile]
    DI --> M6
    M3 --> M6
    M5 --> M6
    M6 --> M7[M7: technical pilot and operations]
    M7 --> M8[M8: final institutional acceptance]
    I[Institutional owners, real rights and approvals] --> M8
```

M1–M7 are technical milestones that may qualify against TestIdP, mock/reference
authorities and synthetic data. Institutional identity, source grants, real
Anny tenant behavior and protected-data approvals are intentionally deferred to
M8. This is a transfer of the original institutional criteria, not a waiver.
Synthetic acceptance evidence must be labeled as such and cannot authorize real
writes, protected context or institutional rollout. P1–P6 also use synthetic
identities and an independent test plugin; they do not require live M3–M5.

1. **Finish the synthetic Service-IT demo slice.** The current reviewed fixture
   inventory is 301 documents (271 Service-IT and 30 Intranet), including 241
   newly inventoried Service-IT entries: 183 authenticated FAQ fixtures, one
   additional valid public RSS FAQ, 22 services, 11 news items, 19 links and five
   forms. Category landing pages are excluded. These counts describe inventory,
   not deployed content. Keep bounded HTML acquisition separate from real-source
   qualification and verify the exact artifact before reporting deployment.
2. **Review PR #78 at its exact candidate revision.** The candidate is `1ffd651`
   with green CI and remains unmerged. Review and merge the adapter work at a
   qualified head; that code review does not accept M3 or authorize source access.
3. **Complete technical M1 and M2 qualification, then the current deployment
   path.** Specify and test identity/integration contracts with TestIdP and mock
   authorities. Complete the deferred M2/P1–P6 matrix and BUD-A1/WEB-A1. Implement
   #79 with an exact source SHA, required CI, state/budget preservation, private
   Coolify administration, an authenticated replay-bounded trigger, health
   checks and a working rollback. Do not replace a newer candidate with an older
   main build.
4. **Qualify M3 and M4 in parallel against synthetic/reference contracts.** M3
   covers signed fixtures, HTML/web extraction, permissions, two-user allow/deny,
   rights-change behavior, reviewed German/English cases and incident freshness
   as represented in test data. M4 covers mock account linking and permitted
   resource/booking views. Actual owner grants and source/tenant semantics remain
   M8; they are not blockers to closing these technical milestones.
5. **Qualify M5 after M4** using reference contracts and mocks for exact
   confirmation, stale/foreign proposal rejection, cancellation, idempotency
   and reconciliation after unknown outcomes. Do not issue live writes in this
   milestone.
6. **Prepare M6 offline now and finish it before M7.** Use synthetic datasets
   and adversarial cases, compare quality, citations, tool arguments, latency,
   measured costs and security per profile. DeepInfra/DeepSeek-V4.1-Flash is the
   requested next provider after the Service-IT slice; follow [#81](https://github.com/metaneutrons/HASI/issues/81) and
   [DI-A1–DI-A4](model-provider-routing.md#deepinfra-follow-up) without reopening
   #32–#34. Provider contract/model compatibility and credential readiness are
   unverified. Complete BUD-A1 before paid evaluation. CACHE-A1 remains separate;
   missing counters do not establish cache hits or savings.
7. **Accept M7 as the synthetic technical pilot.** Complete real iPhone/Safari
   and Android/Chrome UX and accessibility flows, encrypted-backup restore,
   off-host monitoring, incident handling and rollback using synthetic data.
   This milestone does not need institutional source approval and does not
   qualify real SSO or writes.
8. **Complete M8 last** as the institutional go/no-go. Real identity, both
   sources' access and rights, Anny customer delegation/eligibility and vendor
   conformance, protected-data processing approvals, named owners, reviewed real
   acceptance cases and recorded institutional go/no-go must be present before
   rollout. Scope-specific authorization precedes any M8 real-write or protected-
   context test. See [M8 in the MVP plan](hasi-mvp.md#institutional-acceptance-m8).

Container publication is independent and remains a separately requested
Release Please delivery under #17. If an institutional deployment consumes a
published image, its exact candidate must pass D3; demo publication does not
qualify M2 or M7. Later integrations stay outside MVP acceptance. Select their
implementation order by owner readiness, user value, API evidence and operational
capacity, rather than issue number. Public corpus inventory and API discovery can
proceed before the shared platform is complete.

## Plugin delivery slices

Execution: the adopted V3 structure keeps one M2 issue, [#49](https://github.com/metaneutrons/HASI/issues/49),
with six distinct P1–P6 criterion groups. Existing P*-A* identifiers and this
reviewed plan remain the acceptance authority. Transfer the stage, next action,
blockers and evidence from each source issue #69–#74 before closing it as
`not_planned`; neither a transfer nor the merged implementation accepts a P
group or M2. HASI application components remain TypeScript.

### P1 — Contracts and complete journeys

Tracking: #49, P1-A1–P1-A4; former source record [#69](https://github.com/metaneutrons/HASI/issues/69) retains history.

Dependencies: existing plugin architecture; no live HsH credentials required.

- **P1-A1:** Specify separately plugin/package identity, immutable version,
  installation instance, configuration revision, upstream tenant and personal
  account binding. Replace universal anny-shaped actor claims with minimized
  plugin-specific projections. Define configuration schema plus UI metadata,
  logical secret requirements, protocol compatibility and migration rules.
- **P1-A2:** Specify generic tool/result, provenance, pagination and proposal
  envelopes, eligible tool discovery and collision-safe names. Document model,
  app-only and host-confirmation paths. Untrusted declarations cannot grant
  authority or select credentials/origins; tool visibility is not authorization.
- **P1-A3:** Review an end-user room/knowledge journey and administrator
  connect/configure/test/activate/update journey. Separate central service setup
  from personal consent/renewal/revocation. Name every loading, denied, expired,
  unavailable, stale and uncertain-outcome state and its user action. Preserve
  the original task/draft when authentication resumes. Make source/instance
  selection understandable, clarify genuinely ambiguous targets and communicate
  permitted capabilities without requiring a technical plugin/tool catalogue.
- **P1-A4:** Record the compatibility strategy for current manifests, old chat
  results and pending proposals, with contract examples and valid/invalid
  fixtures. Inventory current SDK compatibility before choosing an Apps package.
  Resolve operator trust and isolation ownership before P5/P6 activation.

### P2 — Bounded MCP Apps feasibility proof

Tracking: #49, P2-A1–P2-A4; former source record [#70](https://github.com/metaneutrons/HASI/issues/70) retains history.

Dependencies: P1 contracts relevant to reads, presentation and identity.

Current decision from [#70](https://github.com/metaneutrons/HASI/issues/70):
retain the read-only feasibility implementation, use native results by default,
keep the public Apps flag off, and do not admit unreviewed third-party Apps. The
original feasibility approach below records what P2 must assess before any
reconsideration; it does not authorize production adoption. The official
extension supplies UI resources, iframe communication and app-only tool
visibility; HASI must implement and qualify host enforcement. See the
[official overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html).

- **P2-A1:** Deliver one read-only Anny result view over the existing mock/client,
  with compact results, office/workplace distinctions, filter changes and paging.
  Preserve the requested date/time. Instrument a fixed user journey: filtering
  and paging make typed tool calls and zero additional model generations; measure
  initial/interactive latency, calls and input/output tokens without assuming
  cache hits or claiming provider billing savings.
- **P2-A2:** Enforce a sandbox/CSP, reviewed immutable UI resource identity,
  message source/instance binding, allowed methods, bounded payloads and resource
  fetch/redirect/network policy. Reject forged messages, cross-chat/instance
  calls and undeclared tool/resource access. Expose no provider/service tokens,
  SSO credentials or host cookies to the view. Deny arbitrary view-originated
  messages/context updates, navigation and network access unless explicitly
  approved by host policy; they must not initiate an unreviewed model call.
- **P2-A3:** Feed HASI theme tokens, locale, time zone and dimensions into the
  view; test theme changes, keyboard/focus, touch, text enlargement and loss of
  the UI resource. A useful fallback remains available. State the protocol and
  library versions qualified; do not assume future native-app host support.
  The [host-context contract](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiHostContext.html)
  supports environment delivery but does not enforce design consistency.
- **P2-A4:** Record a go/no-go with security, mobile, accessibility, performance
  and compatibility findings. If Apps fails the gate, retain the standard/native
  presentation path and review the revised implementation approach before
  extending it. A successful iframe render alone is not acceptance.

### P3 — Registry-driven chat and migration of existing tools

Tracking: #49, P3-A1–P3-A4; former source record [#71](https://github.com/metaneutrons/HASI/issues/71) retains history.

Dependencies: P1 and P2 go/no-go; retain the existing signed invocation boundary.

- **P3-A1:** Derive model tools from approved installed contracts and server-owned
  user/turn/data policy. Remove fixed anny/knowledge enums as an installation
  prerequisite. Test duplicate names, forbidden tools, oversized/malicious schemas,
  injection in descriptions/results and model switches. Bound discovery/context
  size and tool-result projection; Apps data is not automatically safe or hidden
  from the model merely because it is structured.
- **P3-A2:** Migrate anny and knowledge through the same contracts as an external
  test plugin. Preserve room search, own bookings, source access/citations,
  prepare/confirm booking and cancellation, interval checks, source-reader
  quality and per-persona isolation. Anny customer IDs remain private to its identity adapter. The model
  provider registry and existing accepted routing policy are reused.
- **P3-A3:** Generic host-owned confirmation displays the exact instance/account,
  target, effect, time and consequences. Bind proposal, actor, arguments, plugin
  and configuration revision; recheck authority/current state at execution.
  Neither a view nor a model can confirm. Reject stale/tampered/foreign actions;
  reload/repeated confirmation cannot duplicate writes. Unknown outcomes use
  authoritative status/reconciliation rather than blind replay.
- **P3-A4:** With Apps disabled, legacy results or a removed view resource, retain
  a readable transcript and source references subject to current access checks.
  Historical cards do not run tools or execute old actions merely by rendering.
  Explicitly test both Apps-enabled and fallback modes.

### P4 — Administrator configuration and account lifecycle

Tracking: #49, P4-A1–P4-A4; former source record [#72](https://github.com/metaneutrons/HASI/issues/72) retains history.

Dependencies: P3 and durable instance/configuration state; real administrative
authorization before institutional use. Demo administration stays workspace-only.

- **P4-A1:** Provide schema-driven setup with labels/help/conditional fields,
  draft validation, connection testing and explicit activation. Distinguish
  configured, reachable, authenticated, authorized and user-ready states. Show
  instance/tenant and concrete field-level remedies without exposing secrets.
- **P4-A2:** Server-side validation and versioned configuration support multiple
  instances, optimistic concurrency and an auditable operator change record.
  Bind approved logical secret requirements through the HASI secret abstraction;
  support replacement/rotation without secret readback. Client/model/plugin input
  cannot choose arbitrary secret references or credential origins.
- **P4-A3:** Keep per-tool policy separate from plugin enablement. Distinguish
  disable, personal disconnect and uninstall, showing effects on pending actions,
  retained history and data. Personal login/renewal returns to the original task;
  revocation invalidates dependent rights/context. No credentials enter chat forms.
- **P4-A4:** Qualify complete setup, errors, update review and reconnect on phone
  width, keyboard and assistive technology. Form generation is not evidence of
  good UX. Treat Apps as an optional result UI, not a replacement for trusted
  host installation/configuration and confirmation controls.

### P5 — External connection and independently updated artifacts

Tracking: #49, P5-A1–P5-A5; former source record [#73](https://github.com/metaneutrons/HASI/issues/73) retains history.

Dependencies: P3/P4, P1 trust policy and a qualified isolation/runtime design.

- **P5-A1:** Connect an operator-approved remote MCP endpoint with approved
  manifest/capabilities, destination policy and minimized per-instance authority.
  Apply resolved-address, DNS-rebinding and redirect checks. Support a reviewed
  adapter for plain MCP servers that lack HASI's effect/authorization contract;
  an unmodified MCP server is not automatically HASI-compatible.
- **P5-A2:** Separately support deploying a reviewed, digest-pinned plugin release
  from an approved external source. Verify publisher provenance, compatibility
  and license/dependency inventory. Do not run arbitrary repository install/build
  scripts in the core. Enforce filesystem, credential, network, CPU/memory and
  execution-time boundaries; prove denial cases as well as allowed behavior.
- **P5-A3:** Stage health/configuration/migration checks before activation. Show
  changed schemas, effects, permissions, network destinations and UI resources
  for renewed approval. Coordinate active revision across instances, invalidate
  incompatible pending actions and record immutable audit events.
- **P5-A4:** Demonstrate update and recovery using retained previous artifact and
  compatible configuration/state. Irreversible migrations need a restore/forward
  recovery plan; an old image alone is not rollback. Failed preflight leaves the
  active version usable; an unknown activation state is reconciled before retry.
  Revalidate current secret references and rights on recovery; rollback must not
  reinstate revoked credentials, grants or superseded trust approvals.
- **P5-A5:** Document the runtime matrix. Production executable plugins run outside
  the core's trust boundary. The current public demo runs on Coolify and uses only
  reviewed demo composition; Vercel is retired and is not an execution target.
  Demonstrate truly independent updates outside the co-located deployment; do not
  present a rebuilt application bundle as independent plugin distribution.

### P6 — Independent plugin and end-to-end qualification

Tracking: #49, P6-A1–P6-A4; former source record [#74](https://github.com/metaneutrons/HASI/issues/74) retains history. The current PR #78 packaging repair is a separate active blocker; passing it does not complete this qualification group.

Dependencies: P1–P5; synthetic TestIdP and mock authorities support technical qualification. Real institutional SSO is M8.

- **P6-A1:** A small independently versioned test plugin outside the host workspace
  is connected, configured, used in chat, updated and rolled back without a host
  rebuild or domain-specific core edit. Include multiple tools, an optional Apps
  view/fallback and a synthetic confirmed action. A fixture package alone is not
  proof of external distribution; identify the exact external artifact/source.
- **P6-A2:** Qualify reauthentication without task loss; an update/disable during
  a pending booking; configuration races across runtimes; malicious UI/schema/
  results; lost connection during execution; authoritative unknown-outcome
  recovery after mobile reauthentication; denied cross-workspace/account/resource
  calls. Preserve anny and
  knowledge regression evidence and test the actual deployment topology.
- **P6-A3:** Exercise chat and admin on actual iPhone/Safari and Android/Chrome,
  including keyboard, safe areas, focus, VoiceOver/TalkBack, 200% text and reload.
  Apply the existing [mobile acceptance](../architecture/technical-basis.md#mobile-experience-and-acceptance),
  including 320/375/390/768/1280 px viewport checks. Record platform versions,
  measured latency and omissions; emulation alone cannot satisfy native gates.
  This slice qualifies plugin chat/admin flows with synthetic data. M7 qualifies technical
  pilot operations with synthetic data; M8 owns real SSO and source rights.
- **P6-A4:** Publish developer contracts/examples and administrator runbooks for
  setup, account renewal, rotation, disable, update and recovery. Update README
  with demonstrated capabilities and limits. Map each P criterion to exact
  artifact/code revisions and durable evidence before accepting P1–P6. M2 still
  requires its separate technical identity, budget and deployment gates. M8 owns
  institutional identity and authorization.

## Supporting gates and external decisions

The following qualifications carry the former supporting issues into M2/M6
without reopening accepted provider routing or inventing a coverage percentage:

- **BUD-A1 (M2 #49; transferred from #66):** Define server-owned budget scopes and atomic cross-instance
  reservations across concurrent requests, fallback attempts and output limits.
  Tests cover exhausted and unavailable budget state, timeouts, cancellation,
  failed/unknown usage and reconciliation. Unknown counters are never zero spend.
  Separate conservative admission bounds from verified provider billing; record
  currency/rate configuration, operator quotas, safe exhaustion behavior and any
  hard-cap limitations explicitly. Preserve content-free telemetry and secret
  boundaries; no new paid resource, quota increase or evaluation run is authorized
  by this tracking migration. No fallback may bypass exhaustion. Qualify before production acceptance or paid benchmarks;
  offline mocks need no provider spend.
- **WEB-A1 (M2 #49; transferred from #67):** Inventory each shared strictness/lint/coverage gap, implement a
  bounded Next-compatible migration or review an explicit, justified exception
  in the versioned repository findings. Verify Node 24/26 and meaningful affected
  user workflows; preserve existing gates and distinguish configuration failures
  from application regressions. No blanket coverage target or mechanical tests
  are implied. Green current checks alone do not resolve the inventory, and an exception is not automatically authorized here.
- **CACHE-A1 (M6 #53; transferred from #64):** Preserve the existing measurement contract. Only a documented
  positive provider cache-read counter, exact model/environment/request-prefix
  conditions and preserved raw-to-SDK evidence establish a hit. Honor quotas and
  Retry-After. Missing counters remain unknown; no unlimited retries, support messages or unsupported savings claims.
  If unavailable, record the blocker and seek a scope decision. Other work can
  proceed using measured tokens/calls/latency without claiming cache savings.

M1 defines technical identity and integration contracts and exercises them with
TestIdP and mock authorities. M8 must identify institutional owners for real
IdP/account lifecycle, both knowledge sources, Anny rights, data/model approvals
and downstream operations. Hosting, security/secret custody and pilot operations
require named accountable owners. Synthetic tests qualify technical controls;
they do not replace source-owner approvals, real API semantics or final
institutional acceptance.

## Migration, verification and delivery discipline

Introduce versioned contracts alongside a bounded compatibility adapter, migrate
anny and knowledge, then remove obsolete paths only after parity evidence. Keep
host identity, rights and write confirmation authoritative throughout. Bind view
state to actor, chat, installation, invocation and revision; persist only approved
minimal state and recheck rights after reconnect. A UI teardown is not a durable
business-state transaction.

During development, run focused contract, policy and workflow tests. At each
integration point, qualify the exact candidate with required CI, supported Node
versions and relevant PostgreSQL/concurrency paths. Use isolated malicious
fixtures to prove new gates reject bad inputs as well as accept valid ones.
Reserve native phones, deployment checks and multi-platform container work for
their stated gates. Refresh/qualify only the next PR in merge order; unrelated
documentation edits do not justify repeating expensive runtime qualification.

Use reviewed PRs per milestone; reference its P*-A* criterion IDs in #49 without
automatic closing words for partial work. Source records #69–#74 retain history.
D2 (#16) records the completed historical Vercel
delivery and remains closed. Current qualified main builds must use the Coolify
path in #79: deploy the exact intended main SHA after required CI, preserve
database and budget state, and verify readiness and rollback. Never deploy an
older main commit over a newer running candidate. Release Please remains the sole
container version/tag authority; no release is performed merely to close a
planning issue. No dates or cost estimates are committed without team capacity,
runtime design and approved spending limits.

The main risks are expanding the plugin initiative into an unbounded marketplace,
trusting schemas as authorization, mistaking iframe isolation for complete security, presenting
synthetic rights as institutional acceptance, and promising rollback across an
irreversible migration. P1/P2 bound the design; P3/P4 prove existing workflows;
P5/P6 qualify external execution. If a required boundary fails, record the blocker
and revise the plan through review rather than silently narrowing acceptance.

## Plan review and completion

Unified sequencing update, 2026-10-18: v2 reconciled the issue graph with the
Coolify cutover, source-deployment follow-up #79 and the decision to put
institutional acceptance in M8 #80. Adopted V3 changes the tracking shape only:
#47 indexes delivery, #49 contains M2 and six separately qualified P groups,
and #55 retains the post-MVP roadmap. It preserves all M1–M7, M8, D1–D3,
P1–P6, BUD/WEB/CACHE criteria, status and evidence; nothing is waived or
accepted by transfer. GitHub remains the status authority while successor issue
bodies are updated and source issues close as `not_planned`. The
[issue-roadmap audit](../verification/2026-10-18/issue-roadmap-audit.md) is the
pre-V3 snapshot; the target graph is documented here.

Execution decision, 2026-10-18: Fabian requested completion of M2 implementation
while deferring tests. Deliver the remaining contracts, account/configuration UX,
action reconciliation and independent deployment/runtime implementation now;
retain focused development regression checks and required CI gates. Final target-
device, assistive-technology, adversarial/isolation/recovery tests remain
pending; institutional qualification is reserved for M8. This sequences
implementation before acceptance;
it does not waive those criteria. M2 technical acceptance may use TestIdP and
mock authorities; institution-specific identity approval is explicitly M8. Record
M2 as awaiting qualification rather than closing unverified acceptance criteria.

Review P1 contracts and journeys before P2 implementation, record the P2 Apps
go/no-go, and review P5 isolation/distribution before admitting external
executable code. #47 indexes the unified delivery; #49 owns M2, P1–P6 and the
transferred budget/frontend obligations; #53 owns CACHE-A1; #55 holds the eight
future proposals. Source records link their successor and retain the explicitly
unaccepted state in their preserved history.

This plan is complete as a delivery initiative only when the relevant active
milestones and all adopted P/BUD/WEB criteria have evidence. Technical M1–M7,
final institutional M8, plugin-platform qualification, container publication
and later integrations remain distinct acceptance decisions. Future changes record date, decision/PR,
affected criterion IDs and evidence that must be requalified.
