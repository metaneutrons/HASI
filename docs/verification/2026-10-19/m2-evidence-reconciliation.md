# M2 evidence reconciliation: WEB-A1, BUD-A1 and P2-A4

Date: 2026-10-19. Source reviewed: main `442897d63aa30acef7fa6b5a5f8af2ff1b82d596`.
This is a dated evidence reconciliation, not an acceptance decision. GitHub
[M2 #49](https://github.com/metaneutrons/HASI/issues/49) remains the live
execution ledger and the
[consolidated plan](../../plans/consolidated-delivery.md) remains the acceptance
authority. No criterion is waived by this evidence review. Fabian's later Plan V7
decision
separately transfers only the 1-second API acceptance to M8-A9; local UI ≤ 200 ms
and all other M2 gates remain.

## Snapshot and scope

PR #123 is merged at main `442897d`. The dated delivery readback completed at
`2026-10-19T19:19:56.501Z`; public HTTPS was ready at that exact revision. The
345-row active baseline was unchanged (zero missing or changed rows), with the
same database and volumes and budget fingerprint
`0f16371ccf718735e0fbc510a17e448ad937e69f4b938e160812d867b7b7f5d3`. This
confirms that delivery preserved that observed state. It is not a standing
pipeline status or milestone decision; consult #49 for current execution status.

This review compares the current web compiler/linter configuration with the
historical WEB-A1 findings, reconciles the local budget-topology/router evidence
with BUD-A1's remaining deployment and billing boundaries, and maps the MCP Apps
no-go/native-history evidence to P2-A1–A4. It does not run application tests,
provider calls, browser or device journeys, or remote CI.

## WEB-A1: configuration findings versus qualification

The 2026-10-16 repository audit said web TypeScript did not inherit all shared
strict options and web ESLint was not type-aware strict ESLint. Inspection at
`442897d` shows both statements are stale:

| Artifact | SHA-256 at reviewed source | Observation |
| --- | --- | --- |
| [`apps/web/tsconfig.json`](../../../apps/web/tsconfig.json) | `00cdeb2798fe9c83c001d892fcec2dffe113244a6db712231c46f067351a7c5f` | Extends the root base. Shared `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax` and `isolatedModules` remain inherited. The web project supplies its Next-compatible target, libraries, module resolution and JSX settings. |
| [`apps/web/eslint.config.mjs`](../../../apps/web/eslint.config.mjs) | `07db9f510f81403b0989b936a088f3f459927af42eefb45a020ae6b01ef90f8e` | Combines Next rules with type-aware `strictTypeChecked` and `stylisticTypeChecked` rules for TS/TSX, using the web tsconfig as the parser project. |
| [`tsconfig.base.json`](../../../tsconfig.base.json) | `3d60d533c8ca94c843d1a92abc03a549eb232359c447a5ca7a0854b344e3a542` | Shared strict compiler-options source inherited by the web project. |

The [root CI workflow](../../../.github/workflows/ci.yml) runs build, lint,
typecheck and coverage on Node 24 and 26. [`vitest.config.ts`](../../../vitest.config.ts)
discovers tests in `apps/**`, including web tests, but its coverage include list
is limited to shared packages, the API, Anny plugin and knowledge plugin. Web
source therefore has no coverage threshold. This is the configured scope; it
does not imply blanket frontend coverage or authorize a new percentage target.

The WEB-A1 configuration migration is present in source. The plan also calls
for meaningful affected workflow qualification. Existing records include
bounded TestIdP, chat, plugin, administration and booking browser journeys; they
do not collectively establish one complete integrated admin/chat lifecycle.
That remaining journey belongs to the P1/P3/P4/P6 criteria and stays in #49.
No workflow was run for this reconciliation, and the configuration inspection
does not establish integrated workflow or M2 acceptance.

## BUD-A1: what the shared-topology run establishes

The existing [topology report](m2-model-budget-topology.md) records two
Node-version runs of the actual production-built `/api/chat` path in a local
disposable topology: two Next.js processes and two API processes, a PostgreSQL
18.6 ledger and a fixed loopback HTTPS fake provider. The qualification script
hash in the report matches the source at the reviewed head:

| Artifact | SHA-256 |
| --- | --- |
| [`scripts/qualify-model-budget-topology.ts`](../../../scripts/qualify-model-budget-topology.ts) | `2a59ffbb1ff675d09543416c463ac0a5905bab27a25586e3a5280307c96b8ebe` |

The report documents fail-closed missing-state behavior, shared concurrent
exhaustion, a successful synthetic response and settlement, exact budget
denials before the held provider response was released, and denials after one
Next.js process was replaced. The unchanged policy digest represents a UTC-day
limit of 1,250,000 input tokens, 250,000 output tokens and 1,000,000 micro-USD.
Synthetic unknown-use reservations are conservative test holds, not actual
provider spend; the production ledger and counters were not reset.

The report's separate router regression composes the real ledger/admission
objects with an in-memory store: a synthetic Groq timeout leaves its output
hold unknown, and an explicitly allowed GWDG fallback is denied at exhausted
admission before a second provider request. It records 119 focused router tests
passed before integration. This is deterministic router/ledger evidence, not a
live timeout/failover or a second multi-process run.

The limits matter to BUD-A1:

- Both topology runs use one local profile with no fallback and a fixed fake
  endpoint. The separate fallback test does not exercise live GWDG.
- The proxy records aggregate targets. It does not attribute the successful
  admission to a named API replica, so process count alone is not proof that
  both API processes independently admitted requests.
- These runs do not establish provider invoice accuracy, real provider rate
  limits, paid evaluation, or every production database/bootstrap binding. The
  separate exact-main delivery readback above confirms preservation of the
  observed database, volumes, active rows and budget fingerprint at that
  deployment; it does not qualify every deployment binding or provider quota.
  Consult their separate dated records and current #49 state for those gates.
- The GWDG price remains the explicitly approved Groq-based temporary estimate,
  not a contractual SAIA tariff. Replacing it must preserve consumed usage.
  Provider-side quotas and any hard cap remain separate from HASI's conservative
  admission bounds.

This local topology report supplements the ledger, router, deployment and
credential documents; it does not replace them or accept BUD-A1. See the
[budget architecture](../../architecture/model-budget.md),
[credential boundary](../../architecture/llm-router-credentials.md), and the
live [M2 ledger](https://github.com/metaneutrons/HASI/issues/49).

## P2-A4: no-go scope and native-history evidence

The [MCP Apps feasibility record](../2026-10-18/mcp-apps-feasibility.md)
recommends no-go for **unreviewed third-party Apps** in the public demo and
institutional production. Native results remain the default and the public Apps
flag remains off. The recommendation is scoped to unreviewed Apps; the reviewed
Anny view remains an opt-in local experiment. It is not a blanket no-go for all
reviewed views or for the host's native result path.

| Plan criterion | Evidence already recorded | Remaining qualification |
| --- | --- | --- |
| P2-A1: read-only view, preserved interval, typed filtering/paging, zero extra model generations, measured calls/tokens/latency | Local desktop Chromium observed one app-only tool call for each measured filter/page interaction, no `/api/chat` call, preserved interval and fixed viewport widths. | The initial result journey's latency, call count and input/output tokens are not recorded. Plan V6 permits mock/synthetic technical evidence; it does not require a live provider for this measurement. Single local timings are not percentiles, cache evidence or billing savings. |
| P2-A2: sandbox/CSP/resource identity, message binding, method/payload/network policy and hostile cross-context denials | The view uses an immutable resource hash, separate operator review, sandbox/CSP, source-window binding and a bounded read-only bridge. | Browser sandboxing/CSP do not establish a general prohibition on scripted self-navigation, which supports the security no-go for unreviewed Apps. Cross-chat/instance and other unrun negative checks are recorded for any reconsideration; running every rejected-App case is not a prerequisite to retaining the no-go. |
| P2-A3: host context, theme, accessibility and useful fallback | Theme changes and five viewport widths were observed. The native-history record adds a current-authority boundary and component-harness checks for denied/missing view resources without cached disclosure or writes. | The retained native path still needs its full Apps-off/removal/history/access journey under P3-A4 in the target application topology. Keyboard/touch/focus/text-enlargement cases not covered by the reports are unrun; actual devices and screen readers transfer to M8-A7. |
| P2-A4: record go/no-go with security, mobile, accessibility, performance and compatibility findings; if Apps fail, retain native path and review the revised approach | The feasibility document records an engineering no-go recommendation for unreviewed Apps and keeps native results as default. The current-history report supports the native authority/fallback boundary. | The feasibility record now formalizes the scoped P2-A4 disposition across all five dimensions and retains native host results. The security no-go does not require completing every rejected-App negative case first. P2-A1 initial measurements and the P3/P4/P6 native result/history/fallback journeys remain open; this is not complete P2 acceptance. |

The [current native-history report](current-native-history.md) lists nine
application-source SHA-256 values; each was recomputed against the matching
source at `442897d` and matched. Its React component harness used synthetic
403/404 responses at 320/390 px and observed no cached name/location disclosure,
no iframe and zero writes. This supports the native fallback boundary. It is a
component check, not full Next.js/TestIdP, deployment, mobile-device or P2
acceptance evidence.

## Remaining evidence gaps visible in the live ledger

These gaps are not erased by the partial implementation or the local checks:

- **Integrated admin/chat:** prior [M2 foundation evidence](../2026-10-18/m2-foundation.md)
  proves bounded flows, including a TestIdP chat return and configuration/booking
  interactions. The current
  native-history harness and operator gateway lifecycle do not prove a complete
  product journey that connects setup, account lifecycle, chat use, reauth,
  update/disable and recovery. The relevant P1-A3, P3-A4, P4-A3/A4 and
  P6-A1/A2 criteria remain linked from #49.
- **External artifact:** separate v1.0.1/v1.0.2 artifacts completed bounded
  gateway/update/rollback exercises, including a Linux run, as recorded in the
  [external-artifact gateway report](external-artifact-gateway.md). This is
  positive bounded evidence for separately versioned artifacts and their
  source identity: the test producer is in a separate local repository, with
  declared commits and a synthetic signer. The remaining work is the complete
  product journey connecting administration, chat use, update and rollback
  across the intended application topology. The provenance note does not add
  an unrelated-publisher or public-marketplace requirement.
- **UI response target:** the agreed local input-to-visible UI target is 200 ms.
  The admin evidence measures isolated controls in a private component harness;
  it does not supply the missing named chat interactions or complete the viewport/interaction coverage. Measurements of actual rendered components are valid for this target; a separate full-app journey remains a P6 requirement. The
  [admin latency report](admin-ui-latency.md) explicitly leaves the full-app
  coverage open. Do not treat API request timings as UI timings.
- **Public knowledge API target:** the five-user public measurement in the
  [2026-10-19 #49 update](https://github.com/metaneutrons/HASI/issues/49) reports
  `knowledge.search` p95 **1,634.99 ms**, above the
  agreed 1,000 ms API p95 target. Its resource p95 results were 506/479 ms and
  availability results 509/454 ms; those batches passed. The separate [local
  loopback query report](demo-query-performance.md)
  measured synthetic knowledge p95 of 446.55/542.57 ms; that local result does
  not supersede the public failure. The subsequent loopback repeat reached
  p95 1,315.45 ms and still failed; [public evidence](demo-public-performance.md)
  preserves both results. Plan V7 transfers acceptance to M8-A9, so this unmet
  API threshold no longer blocks M2/M7. A qualifying repeat remains required
  before M8 acceptance.

Plan V6 permits technical qualification with TestIdP, mocks and synthetic
fixtures. Physical iPhone/Android and assistive-technology acceptance remain
M8-A7. This record makes no M2, P2, BUD-A1 or WEB-A1 acceptance decision.

<a id="m2-criterion-evidence"></a>

## Addendum — 2026-10-21 P1–P6 evidence map

This addendum preserves the 2026-10-19 snapshot above and maps the later durable
records to the unchanged criteria in the [consolidated plan](../../plans/consolidated-delivery.md#plugin-delivery-slices).
It does not decide acceptance or waive a criterion. GitHub [M2 #49](https://github.com/metaneutrons/HASI/issues/49)
remains the execution-state authority. The report links below contain their
source, machine-result and artifact identities; full source commit IDs are
called out where they bind the independent plugin evidence.

The P1–P6 groups use complementary evidence within each report's actual scope.
No new all-in-one journey, public marketplace, unrelated publisher or named
winning API replica gate is added. The no-go for unreviewed MCP Apps remains the
P2-A4 disposition; it does not create an extra rejected-App test path. Synthetic
TestIdP and reference authorities qualify technical behavior only. Real
institutional identity, source rights, tenant behavior and physical-device/
assistive-technology acceptance remain M8 work.

### Separate M2 foundation and supporting gates

The MVP's M2 row also retains requirements outside P1–P6:

- **Identity, separate frontend/API and recovery:** [the production topology](m2-runtime.md)
  exercises actual TLS Next.js/API transport, TestIdP PKCE across two PostgreSQL-backed
  API processes, concurrent sessions, an API restart, forged session/origin/replay
  denials, and downgrade/logout on both replicas. The [foundation browser record](../2026-10-18/m2-foundation.md)
  separately exercises real TestIdP navigation and retained drafts. These are
  synthetic technical identities; institutional claims remain M8.
- **Worker, isolation and independent runtime:** the signed artifact/worker,
  gateway and managed-container reports mapped under P5/P6 add actual healthy
  plugin processes, constrained network/runtime access, shared route authority,
  state-preserving update/rollback and authoritative no-replay recovery. The
  earlier base-image metadata probe is not counted as healthy execution.
- **BUD-A1:** [the two-version budget topology](m2-model-budget-topology.md)
  exercises the actual built chat route, two Next/API process pairs and a shared
  PostgreSQL ledger with a fixed fake HTTPS provider. Missing/exhausted state,
  concurrent admission, settlement and process replacement are covered; the
  separate router case denies fallback before a second provider request.
  [Generation Stop](../2026-10-21/generation-stop.md) adds cancellation races,
  zero settlement only before dispatch and conservative unknown usage after
  dispatch. No API-replica attribution or invoice accuracy is inferred. Actual
  deployed retention remains the separately linked delivery evidence in #49;
  the approved temporary GWDG tariff is not a contractual invoice rate.
- **WEB-A1:** the strict compiler/linter inventory above is retained. Exact-head
  and exact-main CI for PRs #186/#187 pass on Node 24/26; their delivery comments
  bind candidate and merge trees. The web has no invented coverage percentage.
  Browser and component reports qualify their named workflows separately from CI.
- **Local UI feedback:** [the repeated chat/navigation run](../2026-10-20/local-ui-feedback.md)
  retains 20 samples each for navigation, action menu, results and theme, with
  maxima 14.4/24.8/14.5/16.6ms and a 254ms delayed rejection.
  [Repeated admin feedback](../2026-10-21/admin-repeated-feedback.md) adds 122
  valid samples and its delayed countercase; generation Stop adds 20 samples.
  These are local committed DOM/render-feedback measurements within their stated
  environments, not provider/API latency or a claim about every UI interaction.
  API p95 acceptance remains M8-A9.

### P criterion map

| Criterion | Durable evidence and observed scope | Explicit limit or unresolved item |
| --- | --- | --- |
| **P1-A1 — identity and configuration contracts** | [`plugin-contract-v2.md`](../../architecture/plugin-contract-v2.md) and the [implementation map](../2026-10-18/m2-implementation.md) identify v1/v2 identity, minimized claims, schemas, logical secret slots and protocol compatibility. The [managed pending lifecycle](../2026-10-20/managed-pending-lifecycle.md), based on `c7d599220a53d217d5ac11393e32605099870d14` with qualifier SHA-256 `552665488640cf0ee72a460bca0643184eaec6239e374b1a811b7104f81c9e1b`, denies package-ID-only calls and accepts the installation ID. The [joined browser qualification](../2026-10-21/external-plugin-joined-qualification.md) binds versions to a separate local source repository. | Technical contracts use synthetic identities. Institutional identity/tenant agreements remain M8. The evidence is mapped across separate reports; no single-run cross-contract gate is added. |
| **P1-A2 — generic tool/result/proposal envelopes** | [`plugin-contract-v2.md`](../../architecture/plugin-contract-v2.md), [`m2-implementation.md`](../2026-10-18/m2-implementation.md) (`registry.ts`, `result-envelope.ts`, `tests/registry.test.ts`), [generic result authority](../2026-10-20/plugin-result-authority.md), and [managed state](../2026-10-21/managed-plugin-state.md) cover bounded discovery/results, provenance, proposals and authority bindings. | The architecture record says cross-plugin acceptance remains pending. The reports are mapped here by actual scope; this does not add a combined-run requirement. |
| **P1-A3 — user/admin journeys and interrupted-task recovery** | The [joined qualification](../2026-10-21/external-plugin-joined-qualification.md), [lost-response/personal-renewal observation](https://github.com/metaneutrons/HASI/issues/49#issuecomment-6317566728), and [protected authority recovery](../2026-10-21/protected-authority-recovery.md) retain their exact scopes. [Joined review/recovery](../2026-10-21/joined-review-recovery.md), application tree `af3d2a0c994dd0399020b9cb96b58e8deb5c7493` matching merged `54dbcb724d064083e13f6a9fc39c56eac2f4e4dd`, adds actual installer comparison, expiry/renewal, draft retention through an injected provider failure/reload, and a fresh separately confirmed action. | Ordinary fresh preparation after renewal was already proved by [renewal/fresh confirmation](../2026-10-20/renewal-fresh-confirmation.md). The cause of an older unattributed 503 remains unknown; this is not an extra all-in-one-run or historical-root-cause acceptance criterion. Read-policy limits on changed plugin bindings remain explicit. |
| **P1-A4 — compatibility and migration strategy** | [`plugin-contract-v2.md`](../../architecture/plugin-contract-v2.md) records v1/v2 compatibility and pending-proposal invalidation; [action-history renewal](../2026-10-20/action-history-renewal.md) and [managed-state container lifecycle](../2026-10-21/managed-state-container-lifecycle.md) cover current-format receipts and compatible plugin updates. The latter binds base `288b783425e4d44efe55509311f894082d535f57`, qualifier SHA-256 `56dc8fa23bc93adba78be5f98631263aca3cc5d127573e0a800e8f8ead162284`, and raw report SHA-256 `b8489562a6b64c7a97d5b94c3e43beb8d9906db95f2490968b46504bf51aec4e`. | Pre-release history has no legacy verifier by design. A legacy unsupported host image is not assumed backward-compatible: the current-format managed-plugin update/rollback run does not qualify rollback to a historical host image. [`plugin-result-authority.md`](../2026-10-20/plugin-result-authority.md) retains this history-format rollback/forward-recovery limit. |
| **P2-A1 — read-only view, interval, calls and measurements** | [`anny-app-initial-read.md`](../2026-10-20/anny-app-initial-read.md), baseline `69b9b90a20a4c048e7ab549e3eb76a0c78b1796b`, pins App resource SHA-256 `f370ebc6f9f271c7c0929afc4904a0d9dd153fcfcbee8fd85017bd361293f070`. Its actual browser run records initial/reopen/filter/page/search, one typed read per interaction, preserved interval and no additional model calls/tokens. | This supersedes the 19 October statement that initial-result metrics were missing. Timings are single local response observations, not DOM-paint measurements or percentiles; no provider billing or cache savings are claimed. |
| **P2-A2 — App resource and bridge security** | [`mcp-apps-feasibility.md`](../2026-10-18/mcp-apps-feasibility.md) records the immutable resource, sandbox/CSP, source-bound bridge, bounded read calls and scoped no-go. The initial-read report adds signed API/plugin checks for resource identity, undeclared tools and write denial. | The no-go is for unreviewed Apps. The self-navigation limit remains; cross-chat/instance and other rejected-App cases are for any future reconsideration, not an extra prerequisite to retaining the no-go. |
| **P2-A3 — host context, interaction and fallback** | The feasibility record covers theme and widths; [initial-read observations](../2026-10-20/anny-app-initial-read.md) retain interval/call scope. [Reviewed-view mobile qualification](../2026-10-21/reviewed-app-mobile.md), merged source `f1fee2a362f0887b2ff3d4b7b8cba82fee4eba44`, adds 20 actual Next/TestIdP/API/PostgreSQL width/theme/16–32px-root cases, keyboard entry/refresh/filter/return, and 403/404 view faults with native fallback. Resource SHA-256 changes from `f370ebc6f9f271c7c0929afc4904a0d9dd153fcfcbee8fd85017bd361293f070` to `0c4bd34f8c35d9d224e3d90ee8938f885cfb62efba2d45e6bd324f09d5b887be`. | Technical touch activation remains unverified: the in-app browser rejected raw touch dispatch, and the Mac was locked for the native Simulator attempt. Coarse-pointer layout and 44px targets do not prove touch activation. The pending technical observation remains M2; hardware/AT remain M8-A7. Continuous filters across availability-lease remount are not claimed. |
| **P2-A4 — recorded decision and revised approach** | [`mcp-apps-feasibility.md`](../2026-10-18/mcp-apps-feasibility.md) documents the scoped no-go across security, mobile, accessibility, performance and compatibility, retains native results and keeps the public flag off. | This records the disposition, not acceptance of general Apps adoption or of the other P2 criteria. The 19 October no-go is not a requirement to execute every rejected-App countercase. |
| **P3-A1 — registry tools and policy** | [`chat-route-profile-switch.md`](chat-route-profile-switch.md), baseline `255afe8876eb46685d005a1fb6cee4856cdb48fb`, covers profile/tool switching and a public-only denial in `apps/web/tests/chat-route-policy.test.ts`. [`generation-stop.md`](../2026-10-21/generation-stop.md), base `9c757138844ff2015c2f4101c930345ab2e507c0`, source SHA-256 `6402903175b69b17bd2be4869f7223e171e7709982e9edc66d8150a68541110f`, covers cancellation races and drops late replies before tool dispatch. | These remain bounded reports; this map records those scopes without converting them into a new integrated adversarial rerun gate. |
| **P3-A2 — Anny and knowledge migration** | [`m3-adapter-flow.md`](m3-adapter-flow.md), baseline `e24adaf832eb7e5025b00c34f4b2b330676e09a0`; [`m4-reference-rights.md`](m4-reference-rights.md), baseline `4f73919b541f6096f60d29c52c8e9296a17e0ecd`; and [`required-room-search.md`](required-room-search.md), baseline `20bd019e79098bea2c5e10a8b36a29fdeb9afdcc`, cover synthetic source access, two-subject rights and room-search behavior. The joined reference-plugin run is separate external-contract evidence. | Live institutional source rights, real Anny tenant behavior and vendor conformance are M8; the supplied booking/VPN dialogue is separately tracked under M6. |
| **P3-A3 — host confirmation and outcome reconciliation** | [`managed-pending-lifecycle.md`](../2026-10-20/managed-pending-lifecycle.md) covers stale status/confirmation denial after update, disable, re-enable and rollback. [`managed-state-container-lifecycle.md`](../2026-10-21/managed-state-container-lifecycle.md) observes exit 73 after an atomic source commit, a fixed 409 while runtime authority is unavailable, restart, and same-execution reconciliation without replay. The later #49 [lost-response comment](https://github.com/metaneutrons/HASI/issues/49#issuecomment-6317566728) verifies browser receipt recovery after personal renewal. | These later observations supersede the specific lost-confirmation-response/personal-renewal failure; they do not claim that every earlier unknown outcome had the same cause. After the execution token is sent during `client.connect`, a subsequent failure remains unknown absent authoritative evidence; pre-callTool alone is not a non-execution boundary. |
| **P3-A4 — native history and fallback** | [Native-history fallback](native-history-fallback.md), [current native history](current-native-history.md), [result authority](../2026-10-20/plugin-result-authority.md), and [authority recovery](../2026-10-21/protected-authority-recovery.md) retain current-rights and outage scopes. [Reviewed-view qualification](../2026-10-21/reviewed-app-mobile.md) adds actual local Apps-enabled 403/404 fallback and a separate published Apps-off native/source journey at `a7653f736ea91f816a0657654f84f16d1501ae7a`: the unique active transcript/cards/citations survive reload; only GETs occur after its Document navigation. | The public run uses synthetic authorization/browser-local transcripts; protected OIDC history has separate TestIdP/API evidence. Response interception qualifies UI fallback, not actual rights enforcement. Changed-binding action receipt denial remains the documented current-binding policy; physical continuity is not claimed as visible receipt recovery. |
| **P4-A1 — setup, testing and readiness states** | The [external-plugin joined run](../2026-10-21/external-plugin-joined-qualification.md) observes required-field gating, configuration draft/save/activation, and release stage/review/activation. [`managed-browser-runtime.md`](../2026-10-20/managed-browser-runtime.md), base `1c14ed285263485f40b0020544c6c76e9c9115ad`, records actual TestIdP admin/account UI behavior. [`admin-remote-status.md`](../2026-10-21/admin-remote-status.md) covers named success/error/recovery announcements. | Synthetic TestIdP is technical evidence, not institutional authorization. |
| **P4-A2 — config revisions, audit and secret boundary** | [`m2-implementation.md`](../2026-10-18/m2-implementation.md) maps `plugin-configuration.ts`, `plugin-config-fields.tsx` and CAS/settings tests. The managed-browser report observes two API processes and v1/v2 configuration; [`plugin-release-provenance.md`](../2026-10-21/plugin-release-provenance.md), base `826531cf6d3677c24eea563abf2dd9797360df64`, implementation `9bd45f675aa948126d3fc9484386df3d126dcbf6`, binds source/license provenance before image admission. | These runs use synthetic identities and local fixture credentials; they do not establish institutional credential custody. |
| **P4-A3 — policy, disconnect, renewal and retained data** | [`protected-disconnect.md`](../2026-10-20/protected-disconnect.md) observes immediate redaction, retained draft and no later model-context delta. [`renewal-fresh-confirmation.md`](../2026-10-20/renewal-fresh-confirmation.md), app tree `c0334a049b4155a5d8d1974fe5c452ca4ba7a743` matching merged `b728cfa13236d008022934f6825f27a0386c762b`, observes expiry, renewal, old-action invalidation and one new confirmed effect. Comment 6317566728 separately observes recovery of a confirmed receipt through personal renewal. | These are complementary scenarios; the 6317566728 run itself did not force expiry. Real external-provider revocation remains outside M2. |
| **P4-A4 — browser setup/error/update/reconnect and accessibility** | The joined run covers five widths. [Admin status](../2026-10-21/admin-remote-status.md) qualifies eight named keyboard cases; [repeated feedback](../2026-10-21/admin-repeated-feedback.md) records 122 valid sub-200ms samples and a rejected delayed control. [Shell accessibility](../2026-10-21/shell-accessibility.md) records 30 bounded scans. [Rendered contrast](../2026-10-21/rendered-contrast.md) and [actual mobile navigation](../2026-10-21/mobile-nav-contrast.md#rebuilt-application-readback) qualify their calibrated named text groups. | These bounded scopes do not establish every application state or native-device/AT acceptance. The earlier named contrast gaps are superseded by the calibrated reports; P2-A3 retains the specific pending technical touch observation. |
| **P5-A1 — approved remote endpoint and plain MCP** | [`m2-implementation.md`](../2026-10-18/m2-implementation.md) maps `plain-mcp-adapter.ts` and loopback network counterprobes. [`plugin-gateway-lifecycle.md`](plugin-gateway-lifecycle.md), baseline `4727fd2b31e061195cd6a59bf100d382cc1165a0`, observes two gateway processes, signed foreign-installation denials, withdrawal and unauthenticated denial. | The exercise uses synthetic endpoints/identities; no live institutional endpoint or tenant is claimed. |
| **P5-A2 — signed artifact, inventory and runtime controls** | [`plugin-release-provenance.md`](../2026-10-21/plugin-release-provenance.md) records source/commit/payload/license binding, actual Linux/arm64 image admission, re-signed-old-image denial and network/isolation controls. The joined report uses separate local source commits `59e15b00c36fdef1cb4083c019dd56f0a628942b` / `40e30f3c1b3900e0505144e11d11326d2c3904f1` for v1.0.0/v1.0.1 and payload SHA-256 `6ca8a1eabf5c26acf414b253e78b20c6bf1a338d8255ba1e91c6ba91b6b389ee` / `62e8b081a4d8934d026104d8b22ebee935c50812c42ddc81c25254c45a492c1f`. | The signer is synthetic and the source is local. No public marketplace, unrelated publisher or reproducible-build assertion is required or claimed. |
| **P5-A3 — reviewed staging and invalidation** | The external joined report observes stage/review/activation and rollback; [pending lifecycle](../2026-10-20/managed-pending-lifecycle.md) supplies stale-action API denials. [Exact release comparison](../2026-10-21/plugin-release-review.md), delivered by [PR #190](https://github.com/metaneutrons/HASI/pull/190#issuecomment-6324521191), adds binding-checked current/candidate declarations, changed sections and approval gating. [Joined review/recovery](../2026-10-21/joined-review-recovery.md) exercises that actual installer-backed UI for first install and update, followed by separate activation and rollback. | The stale button disappeared before a browser click could dispatch; the API counterprobe supplies the stale-call denial. Real institution/publisher trust is not established by the synthetic signer. No public-marketplace or unrelated-publisher gate is added. |
| **P5-A4 — state continuity, update and recovery** | [`managed-state-container-lifecycle.md`](../2026-10-21/managed-state-container-lifecycle.md) verifies current-format v1→v2 state, process exit/restart, same-execution reconciliation, disable/re-enable and rollback without replay. [`plugin-release-provenance.md`](../2026-10-21/plugin-release-provenance.md) records the completed bounded recovery follow-up. | This qualifies synthetic managed-plugin state in the current format, not rollback to a historical host image or protected-history Coolify rollback. |
| **P5-A5 — runtime boundary and independent update** | The joined report uses Docker plugin containers from a separate local Git source and records an unchanged host build ID across plugin update/rollback. [`external-artifact-gateway.md`](external-artifact-gateway.md) records separately packaged versions, including its Linux/amd64 gateway observation. | Local technical distribution is not public deployment. The plan/current issue does not add a public-marketplace gate. |
| **P6-A1 — external test plugin journey** | The joined report identifies the exact separate-repository source commits and payload digests above and observes admin setup, chat use, explicit synthetic action, update and rollback without host rebuild. [`journey-external-artifact-inputs.md`](../2026-10-21/journey-external-artifact-inputs.md) separately qualifies supplied prebuilt-input admission. | The input-admission startup run left the installer empty; it is not counted as plugin use. No public marketplace or unrelated publisher requirement is inferred. |
| **P6-A2 — reauthentication, races, hostile input and recovery** | Managed-state/pending lifecycle, protected disconnect/authority recovery and the lost-response/renewal report retain their mapped scopes. [Joined review/recovery](../2026-10-21/joined-review-recovery.md) adds the injected-provider-failure/draft journey and actual-route hostile-description/forged-tool/provider-error controls. [Two-process configuration races](../2026-10-21/p6-configuration-race.md), root-observed run `08424c83-129d-4682-b5ac-c455afc5c9b0`, supplies simultaneous expected-revision HTTP draft/activation mutations, observed PostgreSQL overlap, one winner/conflict and converged reads, plus 401/403 denial controls. Its exact eight source hashes match the admitted API/store inputs; exit and owned cleanup are observed. | Mocked transport rejection is not real-model prompt-injection resilience; that remains M6. The local race uses test personas and PostgreSQL 18.6, not institutional identity or live service writes. Earlier sequential route-revision tests retain their narrower scope. An unexplained historical 503 is not assigned a cause or converted into an extra acceptance criterion. |
| **P6-A3 — browser/device simulation, text size and accessibility** | [`generation-stop.md`](../2026-10-21/generation-stop.md) binds base `9c757138844ff2015c2f4101c930345ab2e507c0`, client SHA-256 `6402903175b69b17bd2be4869f7223e171e7709982e9edc66d8150a68541110f`, result SHA-256 `e93af716cf02a5264c8e739328a297b5cbc1278cace95303cc8e222e4db019ab`, and qualifies Stop at 200% text. PR #186 merged as `c0255d0e446976a61b0850cc747dd87c288f2704`; its [delivery comment](https://github.com/metaneutrons/HASI/pull/186#issuecomment-6322778969) records the scope. [`ui-contrast-pairs.md`](../2026-10-21/ui-contrast-pairs.md) separately checks simulated confirmation reachability with large text. [Relative typography/source navigation](../2026-10-21/relative-interface-type.md), candidate `63fa7b1f63a2afedae27d16526aa435667a528a0`, records 37 final joined observations: source results, exact reader and expanded configuration/error at all five widths in both themes with measured 32px root text, plus short-height, safe-area and popup controls. [Source-revision recovery](../2026-10-21/source-revision-recovery.md) adds 45 observations including 40 allow/deny/version states at the same widths, themes and 32px root text. | The [corrected rendered contrast report](../2026-10-21/rendered-contrast.md) qualifies 72 named desktop groups / 152 text leaves in matching light/dark states, after pixel-color/coordinate calibration and immediate per-image scroll checks. All 36 pairs pass their font-derived thresholds. The earlier `captureBeyondViewport=true` batch remains rejected because it moved nested scroll by 275px. This is normal-text desktop contrast evidence, not a replacement for the separate five-width layout, text enlargement, keyboard/focus and recovery reports. The 32px default-font and simulated 34px inset checks are not native browser page zoom, Dynamic Type, a physical notch or native software-keyboard/AT acceptance; those limits remain explicit and native-device acceptance stays M8-A7. |
| **P6-A4 — contracts, runbooks, README and evidence map** | [Plugin contract](../../architecture/plugin-contract-v2.md), [artifact/runbook guidance](../../operations/plugin-journey-artifacts.md), [README](../../../README.md) and this 25-criterion map retain exact scope/limits. [PR #187 delivery](https://github.com/metaneutrons/HASI/pull/187#issuecomment-6323118658) binds the README/hosting correction; [PR #188 delivery](https://github.com/metaneutrons/HASI/pull/188#issuecomment-6323726900) binds the map/runbook/contrast addendum at `38dadd6a51ff58f2ffcc0514887b0523a396a8ed`. [PR #190](https://github.com/metaneutrons/HASI/pull/190#issuecomment-6324521191) delivers exact release comparison and its operator guidance; [PR #191](https://github.com/metaneutrons/HASI/pull/191#issuecomment-6325119019) delivers the scoped recovery follow-up. | These are delivered artifacts, not pending candidates. This later reconciliation records the actual configuration race, view/fallback scope and remaining technical touch limit without waiving a criterion. Final M2 acceptance still belongs in #49; M6 human/cache and M8 institutional/device gates stay separate. |

### Superseded snapshots and preserved limitations

The 19 October gap statements above remain accurate for their dated source
revision. Later evidence supersedes only these specific items:

- The missing P2-A1 initial-result measurements are superseded by
  [`anny-app-initial-read.md`](../2026-10-20/anny-app-initial-read.md); its
  single-observation and no-provider limits remain.
- The older failure to recover a lost browser confirmation response through
  personal renewal is superseded for the exact action and execution recorded in
  [#49 comment 6317566728](https://github.com/metaneutrons/HASI/issues/49#issuecomment-6317566728).
  It does not prove expiry in that run, a successful new preparation after
  renewal, or restoration of revoked authority-bound read history.
- The identified authority-lookup path that could persist redacted history is
  corrected and exercised in [`protected-authority-recovery.md`](../2026-10-21/protected-authority-recovery.md).
  This does not explain every earlier draft or unknown-action observation.
- The earlier lack of current-format container-state recovery is superseded by
  [`managed-state-container-lifecycle.md`](../2026-10-21/managed-state-container-lifecycle.md).
  Its actual update/rollback run is synthetic and does not assert historical
  host-image compatibility.
- The previously missing initial App metrics, named admin status/keyboard
  cases, repeated admin-feedback timing and Stop control now have their scoped
  reports: [`anny-app-initial-read.md`](../2026-10-20/anny-app-initial-read.md),
  [`admin-remote-status.md`](../2026-10-21/admin-remote-status.md),
  [`admin-repeated-feedback.md`](../2026-10-21/admin-repeated-feedback.md),
  and [`generation-stop.md`](../2026-10-21/generation-stop.md). They do not
  close the contrast qualification or the remaining evidence map by themselves.

The corrected [contrast report and replay packet](../2026-10-21/rendered-contrast.md)
now supersede the numerical gap for their 72 named desktop text groups. The earlier
moving-capture batch remains rejected, and no untested state or native-device
result is inferred. The source/factory/operator-record limits are explicit.
PR #186 delivers Stop; [PR #187 delivery](https://github.com/metaneutrons/HASI/pull/187#issuecomment-6323118658)
verifies the current README and hosting correction with retained state/budgets.
The mapping/runbook follow-up was subsequently delivered by [PR #188](https://github.com/metaneutrons/HASI/pull/188#issuecomment-6323726900). Its exact delivery is retained above; it is no longer a pending candidate. This later reconciliation does not waive a criterion or accept a milestone. The final requirement-by-requirement decision belongs in #49.

## Release comparison and rebuilt mobile navigation follow-up

The [release-review slice](../2026-10-21/plugin-release-review.md) supplies the
previously missing concrete before/after operator comparison for P5-A3. Its
installer/RPC/route tests and actual-component synthetic HTTP observations are
bounded evidence, not complete admin/chat/update/rollback acceptance. The
[mobile navigation readback](../2026-10-21/mobile-nav-contrast.md#rebuilt-application-readback)
adds actual rebuilt-style48-group evidence to P6-A3 after PR #189 delivery.
It supersedes the preview-only limitation for those named navigation groups,
without extending desktop/mobile coverage to every product state or M8 devices.

## Targeted renewal/failure and actual review follow-up

[Joined review/recovery](../2026-10-21/joined-review-recovery.md) adds actual
installer-backed first-install and update comparisons, three local model calls
including one terminal-injected503, same-chat draft retention through expiry,
renewal/failure/reload, and one separately confirmed fresh action. The ordinary
fresh-renewal path was already qualified by `renewal-fresh-confirmation.md`;
this supersedes any implication that it remained setup-only. The historical
unexplained503 is not assigned a cause by injecting a new known failure.

The report also explains the reproduced historical receipt redaction after
managed update/rollback as the existing current-binding read policy. One physical
effect/source receipt/confirmed journal remains through those transitions;
visible receipt recovery under a changed deployment binding is not claimed.
No current-rights or global history fence is weakened. The actual-route hostile
description and provider503/retry regressions are deterministic mocked-provider
evidence for P3-A1/P6-A2, not real-model resilience or human M6 acceptance.
