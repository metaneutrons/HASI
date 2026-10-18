# M2 implementation delivery — acceptance deferred

Date: 2026-10-18. This delivery builds on main
`8e4a3fbeb18cd0047b370f566ee6557d8b43b41b` (PR #76).
The implementation PR and exact merged/CI/deployment identities are recorded in
[M2 #49](https://github.com/metaneutrons/HASI/issues/49). This document is a
criterion-to-code/evidence map, not a replacement acceptance checklist.

## Decision and scope

Fabian requested completion of M2 apart from tests. Complete the remaining M2
implementation and documentation while deferring final acceptance tests.
Meaningful development regressions and required repository CI remain enabled.
M2/P1–P6 are awaiting qualification; the original acceptance criteria remain
unchanged. The sequencing decision is recorded in the
[consolidated plan](../../plans/consolidated-delivery.md#plan-review-and-completion).

The requirements baseline is plan revision
`8689c46ff9046c831440d41fd7052ef27cd2f047`, with this explicit sequencing addition.
Test-IdP implementation was authorized earlier; no HsH account/role/source
contract or production provider approval is inferred. The public Vercel runtime
continues to use synthetic identity, availability, writes and knowledge.

## Implementation map

| Criteria | Implementation delivered | Development evidence / acceptance boundary |
| --- | --- | --- |
| P1-A1, P1-A4 | V1/v2 package, instance, configuration, credential and account identity; minimized claims; operator secret custody with non-secret rotation revisions; production adapter trust | SDK manifest/invocation/configuration suites; `tests/plugin-boundaries.test.ts`, `tests/plugin-accounts.test.ts`. Institutional identity mapping remains M1. |
| P1-A2 | Generic approved discovery, host-owned source/provenance/pagination envelopes and immutable proposals | `registry.ts`, `result-envelope.ts`, `tests/registry.test.ts`, `tests/plugin-boundaries.test.ts`. A result envelope does not implement retained-context revocation. |
| P1-A3 | Separate central administration and personal account consent/renewal/disconnect/revocation; loading/error/conflict/unknown states and fixed return-to-task paths | Account panels, API lifecycle, browser draft storage and runbook. Actual-device interruption/reconnect and accessibility acceptance deferred. |
| P2-A1–P2-A4 | Existing reviewed Anny read-only App/bridge, bounded protocol and native fallback retained | Earlier [Apps evidence](m2-foundation.md). Decision: native UI default, no-go for unreviewed third-party Apps; public demo flag remains off. Full hostile-browser, performance and native acceptance deferred. |
| P3-A1, P3-A2 | Registry-driven model capabilities with current operator/account permission projection; Anny and knowledge retain their domain wrappers and source readers | Generic-tool, plugin-settings, server-demo and chat-tool regressions. Foreign account/schema/configuration controls remain host-enforced. Live sources/rights are M3/M4. |
| P3-A3 | Trusted instance/account/effect/consequence/cost preview; action-policy revision; CAS single execution claim; durable SDK execution receipt; explicit signed status read and host reconciliation without write replay | `action-policy.ts`, SDK `execution-journal.ts`, `tests/action-reconciliation.test.ts`. Lost response/post-call conflict stays unknown until a valid receipt. A crash between upstream write and receipt commit needs source-specific M5 reconciliation. |
| P3-A4 | Native transcript/result fallback and explicit user-triggered status inspection | Persisted proposal parsers retain previews; rendering a historical card does not invoke a tool. Cross-mode/removal/actual topology acceptance deferred. |
| P4-A1, P4-A2 | Bounded nested/conditional schema editor, discriminated branches, field/unmapped server errors, preserved drafts; CAS settings, audit and explicit activation; host credential custody revisions | `plugin-configuration.ts`, `plugin-config-fields.tsx`, settings/custody regressions. Hidden inactive values are retained locally and omitted from submissions; unsupported schemas are explicit. |
| P4-A3, P4-A4 | Personal account lifecycle with one-use subject/installation/revision-bound callbacks, adapter deadlines, local-first revocation and explicit retry; distinct service disable/remove controls | `plugin-accounts.ts`, synthetic durable adapter, account UI/API tests. Production refuses demo adapters; institution-specific provider adapters and phone/assistive qualification are not claimed. |
| P5-A1 | Approved remote catalogue, bounded network transport and reviewed plain-MCP adaptation with pinned upstream identity/schema and trusted per-user argument/credential projection | `plain-mcp-adapter.ts`, loopback adapter/network counter-probes. Plain MCP declarations cannot establish authority. |
| P5-A2 | Offline self-contained reference artifact with SDK dependency closure, file hashes and license inventory; existing publisher-signed immutable Docker admission/isolation driver | [Reference artifact evidence](reference-plugin.md), packaging and Docker driver regressions. No arbitrary install/build script runs in Core. Real healthy-image/isolation qualification deferred. |
| P5-A3, P5-A4 | Shared CAS route controller, configuration/route binding, staged deployment coordinator, fresh verified endpoint resolution and authenticated fixed-path gateway; retained-artifact recovery path | Route/binding/proxy/driver suites, separate-process reference update/recovery. Route journal fails closed at 512 operations; quiesced operator scope rotation is documented. Production store/container/topology recovery qualification deferred. |
| P5-A5, P6-A1 | Independently versioned self-contained plugin process runs outside Core, updates and restores retained previous route without Core rebuild; runtime composition for separate production API/frontend/worker | `package-reference-plugin.ts`, `qualify-reference-plugin.ts`, [reference evidence](reference-plugin.md), [production composition](../../architecture/production-runtime.md). Locally packaged artifacts are not public registry distribution or a production deployment. |
| P6-A2, P6-A3 | Account renewal and read-only receipt recovery boundaries, configuration/revocation checks and mobile-width host controls are implemented | Focused synthetic regressions only. Full malicious UI, cross-runtime recovery and real iPhone/Safari, Android/Chrome, VoiceOver/TalkBack, keyboard, text-size and latency qualification deferred. |
| P6-A4 | Updated README, developer contracts, production composition and operator setup/renewal/rotation/update/recovery runbooks | This evidence map and linked documents; issue stage remains awaiting qualification. |
| M2 production foundation | Durable signed authority directory, OIDC with fresh authority lookup, separate production API entrypoint and fixed-destination frontend transport; mandatory source classification and reviewed action policy | Production boundaries and frontend transport regressions plus builds. The conservative full-context policy blocks narrower/ineligible model configurations. M1 provisioning and actual institutional deployment acceptance remain open. |
| BUD-A1 | Existing shared atomic reservations/settlement and USD 1/day policy retained | Prior exact-deployment evidence is in #49 and [budget operations](../../architecture/model-budget.md). This delivery does not reset/bootstrap live budgets, change quotas or run model calls. GWDG's approved temporary Groq-Qwen estimate still needs replacement with contractual prices. |
| WEB-A1 | Existing strict TypeScript/type-aware lint migration retained for all new code | Build, lint, typecheck and repository coverage gates remain enabled. Existing coverage scope does not imply full frontend/actual-device qualification. |

## Development checks

The integrated local build, lint and coverage suite passed after the gateway and
action-race corrections: 65 files passed, one PostgreSQL placeholder skipped;
576 tests passed, one skipped. Coverage was 76.72% statements, 73.01% branches,
85.59% functions and 84.04% lines, above unchanged thresholds. Regression cases
include stale rights/bindings on a timed-out execution and a late confirmation
that must not overwrite a reconciled receipt. The local machine had no
`TEST_DATABASE_URL`; required hosted CI supplies PostgreSQL and Node 24/26.
Exact-head CI and final typecheck evidence are recorded in the implementation
PR/M2 issue. These development checks do not claim the deferred acceptance matrix.

The self-contained reference-process qualification completed with synthetic
loopback services and offline packaging. Artifact and license inventory hashes
are preserved in [reference-plugin.md](reference-plugin.md). It did not use a
Docker image, institution, model provider or public package registry.

## Deferred acceptance and deployment limits

- Actual iPhone/Safari and Android/Chrome, VoiceOver/TalkBack, focus/keyboard,
  safe areas, 200% text, native reauthentication and measured interaction latency.
- Full hostile schema/UI/result/model-switch matrix and egress/isolation tests
  against a healthy immutable plugin image in the actual deployment topology.
- Operator PostgreSQL/multi-replica route activation, crash/recovery and retained
  artifact rollback exercises; source-specific uncertain-write reconciliation.
- Institutional OIDC/SAML-broker registration, signed authority provisioning,
  downstream account adapters, source ACL/revocation contracts and model approval
  under M1/M3–M6, followed by M7 pilot/operations acceptance.

No final acceptance test, institutional deployment, live business write, paid
provider comparison or release/container publication is claimed by this delivery.
The main merge updates the synthetic Vercel demo through its existing workflow;
readiness/revision/alias verification is separate from deferred acceptance tests.
