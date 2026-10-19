# M2 evidence reconciliation: WEB-A1, BUD-A1 and P2-A4

Date: 2026-10-19. Source reviewed: main `442897d63aa30acef7fa6b5a5f8af2ff1b82d596`.
This is a dated evidence reconciliation, not an acceptance decision. GitHub
[M2 #49](https://github.com/metaneutrons/HASI/issues/49) remains the live
execution ledger and the
[consolidated plan](../../plans/consolidated-delivery.md) remains the acceptance
authority. No criterion is waived here.

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
  not supersede the public failure. Fix and repeat the public measurement.

Plan V6 permits technical qualification with TestIdP, mocks and synthetic
fixtures. Physical iPhone/Android and assistive-technology acceptance remain
M8-A7. This record makes no M2, P2, BUD-A1 or WEB-A1 acceptance decision.
