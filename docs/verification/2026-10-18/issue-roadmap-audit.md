# Issue and roadmap audit

Historical v2 snapshot. The later user-approved
[v3 consolidation](../../plans/consolidated-delivery.md#v3-issue-graph) targets
13 open issues: #17, #47–#55 and #79–#81. It transfers #14 to #47,
#69–#74 to P1–P6 groups in #49 and #56–#63 to #55, with status, criteria and
evidence retained. Sources close as `not_planned`, not completed. The counts
and open-state rows below describe the earlier audit, not post-v3 live state;
GitHub successors own current execution status. The previous nine closed
records retain their original completion or supersession reasons.

Audit snapshot: 2026-10-18. Base evidence: the complete saved issue body/comment export (35 issues: 26 open, 9 closed; one comment on #49), the five requested plan documents and PR #78 candidate commit `1ffd651b1c561b8dba6182435c233093f47a99e2`. Two approved follow-up issues were added after that export: #80 (M8 institutional acceptance) and #81 (DeepInfra provider work). The current tracking set is therefore 37 issues (28 open, 9 closed); the detailed export audit below maps all original 35 and records both additions separately. Current hosting and work-in-progress facts were checked for this roadmap update. GitHub issues remain the authority for live status, blockers and evidence. No credentials were read.

## Issue map

| Issue | Snapshot state | Purpose, transfer or boundary |
| --- | --- | --- |
| [#14](https://github.com/metaneutrons/HASI/issues/14) | Open | Demo/container delivery epic. D1/D2 are historically accepted; #17 owns D3. #79 owns current Coolify source deployment. |
| [#15](https://github.com/metaneutrons/HASI/issues/15) | Closed—completed | D1 README/branding acceptance; historical. |
| [#16](https://github.com/metaneutrons/HASI/issues/16) | Closed—completed | D2 automatic Vercel delivery; accepted at that time. Vercel is retired; #79 is the current deployment work. |
| [#17](https://github.com/metaneutrons/HASI/issues/17) | Open | D3 Release Please container publication. Native build qualification on an older commit is not an actual release. Keep separate from #79; publication requires a separately requested exact-tag run. |
| [#32](https://github.com/metaneutrons/HASI/issues/32) | Closed—completed | Provider registry, explicit model choice and fallback policy; accepted. |
| [#33](https://github.com/metaneutrons/HASI/issues/33) | Closed—completed | R1 provider/adapter contracts; mocks do not qualify unconfigured providers live. |
| [#34](https://github.com/metaneutrons/HASI/issues/34) | Closed—completed | R2 routing/fallback policy; no protected-data approval or automatic live fallback is inferred. |
| [#47](https://github.com/metaneutrons/HASI/issues/47) | Open | Institutional MVP index; mandatory integrations are Intranet, Service-IT and anny. Technical M1–M7 are #48–#54; final institutional acceptance is M8 #80. |
| [#48](https://github.com/metaneutrons/HASI/issues/48) | Open | M1 technical identity/integration contracts, exercised with TestIdP and mock authorities. Real claims, machine access, rights and institutional contracts transfer to M8. |
| [#49](https://github.com/metaneutrons/HASI/issues/49) | Open | M2 foundation; implementation merged, final acceptance deliberately deferred. Coordinates P1–P6 (#69–#74), BUD-A1 and WEB-A1. Its sole comment authorizes a temporary GWDG rate estimate, not the SAIA tariff or full BUD-A1 acceptance. |
| [#50](https://github.com/metaneutrons/HASI/issues/50) | Open | M3 technical permission-aware knowledge qualification using synthetic signed/HTML fixtures. PR #78 is unmerged, CI-green at `1ffd651`. Real HsH rights, authenticated access and source-owner review transfer to M8. |
| [#51](https://github.com/metaneutrons/HASI/issues/51) | Open | M4 technical anny read/account-link behavior against TestIdP and mock/reference contracts; depends on technical M1/M2. Real customer rights transfer to M8. |
| [#52](https://github.com/metaneutrons/HASI/issues/52) | Open | M5 proposal/create/cancel/idempotency/reconciliation behavior against mock/reference contracts; follows M4. Actual vendor conformance and authorized tenant transfer to M8. |
| [#53](https://github.com/metaneutrons/HASI/issues/53) | Open | M6 formal synthetic/offline model and adversarial evaluation before M7. BUD-A1 precedes paid runs; #81 DeepInfra work precedes the final provider comparison. CACHE-A1 remains open and is not cache-hit evidence. |
| [#54](https://github.com/metaneutrons/HASI/issues/54) | Open | M7 technical pilot with synthetic data; requires actual-device UX, restore, off-host monitoring and operational evidence. Institutional participants and data approval transfer to M8. |
| [#55](https://github.com/metaneutrons/HASI/issues/55) | Open | Index for future plugins #56–#63; outside mandatory MVP. |
| [#56](https://github.com/metaneutrons/HASI/issues/56) | Open | Zammad topic routing; owner, taxonomy, rights and domain isolation discovery first. |
| [#57](https://github.com/metaneutrons/HASI/issues/57) | Open | Restricted read-only public web; approved URL/query/network scope required; never a substitute for protected sources. |
| [#58](https://github.com/metaneutrons/HASI/issues/58) | Open | Examination-regulations corpus for all programmes; needs authoritative inventory, version/cohort rules, reviewed OCR and page citations. |
| [#59](https://github.com/metaneutrons/HASI/issues/59) | Open | Moodle discovery/integration; instance version, enabled functions and personal rights unknown. |
| [#60](https://github.com/metaneutrons/HASI/issues/60) | Open | Stud.IP discovery/integration; HsH API/version and rights require owner confirmation. |
| [#61](https://github.com/metaneutrons/HASI/issues/61) | Open | HISinOne discovery; no HsH business API or authoritative eligibility is established. |
| [#62](https://github.com/metaneutrons/HASI/issues/62) | Open | SAP personnel/time discovery; identify the business system/API; no direct HANA writes. |
| [#63](https://github.com/metaneutrons/HASI/issues/63) | Open | Deferred M365 Bookings placeholder; decide tenant/owner/API go/no-go before defining implementation. |
| [#64](https://github.com/metaneutrons/HASI/issues/64) | Closed—not planned | Cache investigation transferred to #53 CACHE-A1. Work was not completed; no positive cache-read counter or savings claim exists. |
| [#65](https://github.com/metaneutrons/HASI/issues/65) | Closed—not planned | External plugin/configuration work split into #49 and P1–P6 (#69–#74). Installation, isolation, independent updates and journey acceptance remain open. |
| [#66](https://github.com/metaneutrons/HASI/issues/66) | Closed—not planned | Durable budgets transferred to #49 BUD-A1. Admission code is merged; tariff migration/operational qualification remain. |
| [#67](https://github.com/metaneutrons/HASI/issues/67) | Closed—not planned | Web strictness/lint/coverage transferred to #49 WEB-A1. Migration is merged; affected-workflow qualification or reviewed exception remains. |
| [#69](https://github.com/metaneutrons/HASI/issues/69) | Open | P1 contract/journey implementation merged; cross-contract acceptance deferred under #49. |
| [#70](https://github.com/metaneutrons/HASI/issues/70) | Open | P2 Apps feasibility retained; native results default, public flag off, no-go for unreviewed Apps. Security/mobile/accessibility/performance qualification remains. |
| [#71](https://github.com/metaneutrons/HASI/issues/71) | Open | P3 registry-driven chat/confirmation implementation merged; adversarial, history, model-switch, Apps-off and deployed-topology acceptance remains. |
| [#72](https://github.com/metaneutrons/HASI/issues/72) | Open | P4 admin/account lifecycle implementation merged; real-device qualification remains with technical M2/M7, institution-specific qualification is M8. |
| [#73](https://github.com/metaneutrons/HASI/issues/73) | Open | P5 remote/plugin artifact implementation merged; isolation/egress, multi-replica, migration and recovery qualification remains. |
| [#74](https://github.com/metaneutrons/HASI/issues/74) | Open | P6 independent-plugin/mobile implementation merged; external distribution, cold-cache, real-device and adversarial recovery acceptance remains. |
| [#79](https://github.com/metaneutrons/HASI/issues/79) | Open | Current CI-qualified source-build/deployment path to Coolify. Must pin the intended SHA, preserve state/budget, reject unauthorized triggers, health-check and prove rollback. |
| [#80](https://github.com/metaneutrons/HASI/issues/80) | Open | Final M8 institutional acceptance. Owns real identity/claims, both sources' rights, actual Anny authorization and conformance, protected-data approvals, named owners and recorded go/no-go. |
| [#81](https://github.com/metaneutrons/HASI/issues/81) | Open | Bounded DeepInfra/DeepSeek-V4.1-Flash provider addition. Follow DI-A1–DI-A4; additive to closed #32–#34 and complete before final M6 comparison. Provider/model and credential readiness remain unverified. |

## Reconciliation and execution order

The five completed closures (#15, #16, #32–#34) retain bounded acceptance for their stated scope and revisions. #16 is historical: its Vercel deployment was retired. The four `not_planned` closures (#64–#67) are administrative transfers, not completed work; their successors remain open. The new M8 #80 transfer preserves the original institutional acceptance obligations without waiving criteria. The #47/#48–#54/#80, #49/#69–#74 and #55/#56–#63 layers are intentional indexes and work records, not duplicate acceptance checklists.

Current hosting is Hetzner/Coolify with HASI, wiki and private PostgreSQL 18.6. Vercel and Neon are retired. The current Coolify service uses a preloaded image; #79 is not complete. PR #78 is unmerged at `1ffd651` with green CI. Server-side Intranet access is not provisioned and anonymous reads returned `readapidenied`; the public Service-IT RSS lacks per-item dates and active/resolved state. These are institutional M8 qualification inputs, not blockers to synthetic M3 technical acceptance.

The in-progress Service-IT demonstration has a reviewed synthetic fixture inventory of 301 documents: 271 Service-IT and 30 Intranet. The 241 new Service-IT entries are 183 authenticated FAQ fixtures, one additional valid public RSS FAQ, 22 services, 11 news items, 19 links and five forms; category landing pages are excluded. These are inventory counts, not deployed counts or an HsH source inventory. Verify the exact merged/deployed artifact before stating a deployed count or marking demo delivery complete.

DeepInfra/DeepSeek-V4.1-Flash is the requested next provider after the synthetic Service-IT work and before final M6 comparison; issue #81 tracks it against DI-A1–DI-A4. Provider/model contract and credential readiness remain unverified. It is additive through the accepted registry, not a reopening of #32–#34. Do not expose or inspect secret values. The documented backup routine has local encrypted retention and an operator-held copy; encrypted-artifact restore and ongoing off-host replication/monitoring remain open for #54 operations.

## Current unified technical-to-institutional order

The saved 35-issue export is the historical audit basis. The current roadmap adds
#80 as M8 and #81 as bounded provider follow-up. The user approved M8 as a final
institutional barrier after mock/synthetic technical acceptance; original
institutional criteria are explicitly transferred, not waived. See the
[consolidated plan](../../plans/consolidated-delivery.md) and the [M8 criterion
transfer table](../../plans/hasi-mvp.md#institutional-acceptance-m8).

1. **Finish the synthetic Service-IT slice** and verify its exact artifact; the
   301-document figure is the current fixture inventory, never a deployed count.
2. **Review/merge PR #78 at an exact qualified head**; keep institutional source
   access disabled pending M8 approvals.
3. **Qualify technical M1/M2 and #79** using TestIdP/mock contracts, required CI,
   current Coolify deployment, state/budget preservation and rollback.
4. **Qualify M3/M4 against synthetic and reference contracts** after M1/M2.
   Actual source rights and Anny customer authorization are M8, not prerequisites
   for technical closure.
5. **Qualify M5 after M4** with mock/reference create/cancel, idempotency and
   unknown-outcome reconciliation. No live writes occur here.
6. **Complete synthetic/offline M6 before M7.** Finish BUD-A1 before paid runs;
   complete DI-A1–DI-A4 in #81 before final provider comparison. CACHE-A1 remains
   open and cannot be claimed from missing counters.
7. **Complete technical M7** with synthetic data, actual iPhone/Android journeys,
   accessibility, encrypted-backup restore, off-host monitoring and operations.
8. **Close M8 last** with M8-A1–A6 evidence, actual identity/source/Anny/data
   approvals, named owners, controlled participant approval and recorded go/no-go.
   No real writes or protected context before scoped authorization.
9. **Keep #17 and #55–#63 independent.** D3 remains a separately requested
   Release Please publication; future connectors remain post-MVP discoveries.

M8 criteria are M8-A1 real identity/lifecycle/claims; M8-A2 Intranet and
Service-IT access, rights, revocation, freshness and owner review; M8-A3 actual
Anny delegation/eligibility/reads/create/cancel/idempotency/reconciliation in an
authorized tenant; M8-A4 protected-data, provider/embedding, retention and demo
migration approval; M8-A5 named owners, reviewed real cases and controlled
participant approval; M8-A6 evidence-to-contract mapping, denial/revocation/
incident tests and recorded final go/no-go. Scope-specific authorization
precedes real-system M8 tests; final acceptance follows their evidence.

No forced closures follow from this audit. Parent-owned issue edits should
mirror the transfer map and link this plan, preserving #64–#67 successor
records and each issue's acceptance authority.

## Tracking reconciliation applied

All 26 previously open issue bodies were refreshed and read back after the v2
plan was pushed in PR #78: #14, #17, #47–#63, #69–#74 and #79. Current-stage,
next-action and dependency sections now use the technical M1–M7/final M8 split;
previous bodies are retained as explicitly historical evidence. #80 and #81 were
created and read back. The nine previously closed issues retain their bodies,
state and completion/supersession reasons. No additional closure is supported
by the current technical evidence: 37 issues remain tracked, 28 open and nine
closed at this reconciliation snapshot.

A separate M1 closure review found missing direct negative-test evidence for
missing required OIDC claims and duplicate plugin claim declarations/array
values. Stable subject, changed authority, denial and revocation already have
tests. This bounded technical gap is now the next action in #48; absence of
real HsH credentials is not its blocker. M2/P1–P6 retain the explicitly deferred
technical matrix. Current local qualification passed 728 tests in 85 files with
isolated PostgreSQL 18, backend build, strict type checks and lint; those green
checks do not substitute for the explicitly absent acceptance cases.
