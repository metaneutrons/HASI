# Technical M3–M5 acceptance crosswalk

Date: 2026-10-19. Requirements authority: [Plan V6](../../plans/consolidated-delivery.md)
and the [MVP technical rows](../../plans/hasi-mvp.md#delivery-sequence-and-exit-criteria)
at `11148d29cc1bb024c8c6110317c78ad65086da7f`.
This review maps existing qualified evidence; it introduces no new requirements
or waiver. The subsequent Plan V7 API-performance transfer does not change any
M3–M5 criterion or authority boundary assessed here. The corresponding issues
record the final acceptance/closure state.

## Applicable dependencies

The MVP plan explicitly says technical M3/M4 require the **M1/M2 technical
boundaries**, with the qualified #79 runtime where relevant, and do not wait for
institutional grants. M1 is accepted. Those applicable M2 identity, policy,
signed-invocation and durable-action boundaries have their own evidence:

- [Separate identity topology](m2-runtime.md): actual production-built Next.js,
  two API processes, TestIdP with PKCE, shared PostgreSQL sessions, forged/foreign
  request denials, signed authority downgrade, restart and logout.
- [Two-subject Anny reference rights](m4-reference-rights.md): current account
  resolution, distinct resources/customers and denial before downstream calls.
- [Current native history](current-native-history.md): retained assistant/cards
  revalidated against current account/configuration and source authority, without
  historical business execution.
- [Source-committed recovery](anny-source-reconciliation.md): exact proposal,
  subject/account/configuration binding and atomic source/effect correlation.
- #79's exact-main CI-qualified delivery preserves database, sessions and the
  shared budget; [storage/continuity readback](demo-storage-guard.md) records the
  current operational checks.

M2 as a whole remains open for its wider plugin lifecycle, complete product
journeys and performance qualification. Those open criteria remain M2/M7 work;
they are not an additional institutional prerequisite or an unqualified
identity/authorization boundary for every M3–M5 test. This dependency reading
follows the explicit technical-boundary paragraph after the MVP criteria table.

The current regression anchor is `c4c55efc9506b8bbfc273101baff80b20c2d3cfb`,
with successful exact-main CI
[39311840200](https://github.com/metaneutrons/HASI/actions/runs/39311840200)
on Node 24/26. Its PostgreSQL-backed local full gate passed 1,166 tests plus one
intentional platform skip. The later schema-compiler optimization changes no
identity, source, proposal or action contract; its own CI/delivery/performance
results remain separately identified rather than relabeling earlier runs.

## M3 — permission-aware knowledge

| Plan row requirement | Existing observed evidence |
| --- | --- |
| Signed Intranet fixtures and reviewed synthetic HTML/web acquisition | [Adapter-to-chat flow](m3-adapter-flow.md): MediaWiki revision-pinned rendering and reviewed HTML enter signed snapshots, repository, registry/MCP and host API. Changed render/revision/approval denies acquisition before embedding/publication. Source HTTP and embeddings are controlled doubles. |
| Curated German/English cases and two-user allow/deny | The same flow uses reviewed EN Service-IT and DE Intranet content; current source grants determine access for distinct subjects with the same application persona. The [public network journey](m3-incident-transition.md) separately passes eight bounded synthetic checks, including both languages and denied metadata/context/source access. |
| Rights changes, retained contexts, source citations and freshness | Signed grant replacement denies old searches, citations and retained contexts. [Incident transitions](m3-incident-transition.md) cover active/resolved/expired/source-expired/fresh-snapshot recovery; unavailable contexts contain no hidden documents. [PostgreSQL recovery](knowledge-postgres-recovery.md) preserves suspension and prevents stale refresh from restoring revoked access. |
| Instructional-image extraction | Exact reviewed image descriptors/transcripts are bound to content approval and appear only for authorized readers. Changed/unreviewed annotations are denied before publication. This is synthetic reviewed guidance, not image-byte OCR or live pixel-freshness evidence. |

PR #109 merged at `ba693b5`, with successful exact-head CI39259825880 and
exact-main CI39260387147; earlier adapter/image/incident source revisions remain
identified in their reports and #50. No extra implementation gap is inferred
from their explicit non-institutional or non-OCR limits: those limits do not
turn controlled technical fixture evidence into real source approval.

## M4 — account-link and read contracts

| Plan row requirement | Existing observed evidence |
| --- | --- |
| TestIdP/mock account-link and reads | [Two-subject reference flow](m4-reference-rights.md) traverses real TestIdP/OIDC, account service, signed MCP, AnnyClient and TCP contract mock. Different stable subjects with the same role resolve different fixture customers. |
| Only permitted resources/own bookings | Resource/bookings results differ by current grants; permitted availability reaches the mock endpoint, denied availability and foreign cancellation do not. Changed/revoked grants take effect on the next read without a downstream request. |
| Conflicting, missing and duplicate mappings fail closed | Missing, ambiguous, duplicate and conflicting mapping-source outcomes make the account unavailable before a downstream read. Client subject/customer/grant forgery is rejected. |

PR #92 merged at `00a580c`, with successful head CI39214877721 and main
CI39216555567. The subsequent connection/task repair PR #93 merged at `ce20795`
with successful head CI39218401373 and main CI39218821218. Its original-task
continuation UI is recorded in [the service-connection report](chat-service-connection.md).
The broader browser/account/reauth lifecycle remains P3/P4/P6 and M7 work; it
is not an additional M4 row criterion. Vendor account discovery/delegation is
not inferred from synthetic mapping outcomes.

## M5 — proposal, create/cancel and reconciliation contracts

| Plan row requirement | Existing observed evidence |
| --- | --- |
| Fixture customer eligibility and exact proposals | Cancellation and reference-right tests use current customer ownership/resource grants, canonical booking snapshots and host-only execution. Revocation after preparation denies confirmation before any source mutation. |
| Stale/tampered confirmations rejected | `confirmation.test.ts`, `anny-cancellation.test.ts`, `proposal-binding-guard.test.ts` and `proposal-invalidation.test.ts` cover expiry, changed target/time/configuration, foreign owner, signed-event tampering and concurrent execution/invalidation claims. |
| Idempotent retry and cancellation | Confirmation never retries an unknown execute outcome. Repeated confirmation retains the one durable action identity; cancellation requires the owned exact booking and an authoritative cancelled result. Source response-loss tests count exactly one create plus one cancel across both memory and PostgreSQL/two-runtime runs. |
| Unknown-outcome reconciliation | [Source-committed recovery](anny-source-reconciliation.md) demonstrates lost create/cancel responses, absent/foreign evidence remaining unknown, cooldown, exact source receipt recovery and no mutation replay. Receipts are bound atomically to the synthetic source mutation and full subject/install/configuration/arguments. |

PR #121 merged at `104c45bd73edff27d9bf9634632d0038f830ee7f` after
head CI39293673364 and main CI39294913327; its automatic deployment completed
at 17:40:52Z. The 37 focused memory/PostgreSQL/two-runtime checks supplement
existing confirmation/cancellation/invalidation regressions. The earlier report's
pending-CI wording describes its pre-integration snapshot, not current delivery.

## Disposition and retained work

The bounded technical M3/M4/M5 rows and their applicable identity/policy/action
dependencies have supporting evidence above. Their acceptance can be recorded
in #50/#51/#52 after this reviewed crosswalk is integrated; they need not wait
for all unrelated M2 installation/UX criteria. M2/M6/M7 remain open.

Actual HsH identities/source grants and owner review, raw image/OCR quality,
Anny delegation/eligibility/vendor idempotency/terms/live writes, protected-data
approval, native devices and participant acceptance remain M8 under the agreed
scope. No fixture result authorizes any of those operations. The full product
reauthentication, pending-action update/recovery and browser/simulator journeys
remain required in their M2/P6/M7 criteria, without duplication as new M3–M5
requirements. No live business write or provider evaluation was performed for
this evidence review.
