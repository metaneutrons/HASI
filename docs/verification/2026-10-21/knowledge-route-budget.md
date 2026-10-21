# Current-source chat context and pre-dispatch budget release

Date: 2026-10-21. Implementation: `0eb8cd6ef6bf4802d400104a07aa12152f848605`,
on `13fe0d0e58c26787ad39cf5f3de50b5970339a92`. This is bounded synthetic M2/M6
application-control qualification. M2/M6/M7 remain open; this is not a live
provider comparison, human score, completed dialogue or institutional acceptance.
Exact source/test hashes and local runtime are in [the result](knowledge-route-budget.json).

## Defect and correction

The actual protected chat route rechecks source rights immediately before
provider dispatch. When that check fails after budget admission, the router
settles the known undispatched reservation with its internal `{inputTokens: 0,
outputTokens: 0}` sentinel. The admission adapter previously forwarded that to
`ModelBudgetLedger.settle`, which deliberately rejects a zero/zero provider-usage
claim. The route returned a budget-unavailable 503 instead of the source-change
409, and the conservative reservation remained charged despite no dispatch.

The adapter now maps only that trusted internal sentinel to `ledger.release`.
Unknown usage remains on `settle(undefined)`; positive usage keeps its existing
settlement path. Releasing a reserved record is idempotent, retains its record,
and refunds only that reservation. Unknown or already settled records reject a
release with conflict, without changing their usage/cost. Provider-reported zero
input remains invalid in the router; no provider claim can obtain this release.
No existing deployed hold is deleted or retroactively reclassified.

The same finalized actual-route revocation test failed on the original adapter
(exit 1, `expected 503 to be 409`; original source SHA in the JSON). After the
fix it observes 409, no second provider request, unchanged aggregate input/output
usage and cost, one additional released record and zero new unknown/unresolved
records. This reproduces the defect through the real ledger adapter, rather
than a mock settlement function that accepts zero.

## Integrated path and cases

`createEvaluationKnowledgePolicyFixture` creates independent memory state,
ephemeral Ed25519 keys, two signed source snapshots, the actual institutional
repository, signed knowledge MCP, registry and core API. Two subjects complete
real authorization-code/PKCE and verified loopback TestIdP sessions. Source grants
and document ACLs are server-owned fixture definitions, not case entitlements.
The core dispatcher admits only named fixed-origin API methods and dispatches to
the actual API; it does not manufacture successful retrieval/context responses.
The fixture owns and closes its real loopback IdP. It changes no global state.

Eight web cases invoke the unchanged actual chat `POST` route and capture its
provider request after the actual authorization/context rebuilding path:

1. An authorized source reaches the provider, while browser-substituted title/body
   and the private group document do not.
2. An authenticated outsider receives no authorized/private source canaries.
3. A signed source-grant revocation removes old tool text and a previously signed
   derived answer on a later turn.
4. A signed document-ACL change, with advanced document revision, removes the same
   old context and derived answer.
5. Source revocation after history rebuilding but before dispatch blocks that
   dispatch and releases its independently reserved budget.
6. Another authenticated subject cannot replay the first subject's conversation
   receipt to expose its source.
7. A model profile ineligible for the local composition's complete context is
   denied before another provider request or budget reservation.
8. A poisoned permitted source reaches the provider as evidence; a deliberately
   unsafe fake provider tool attempt is rejected, with no other network target.

Five fixture cases separately cover actual session/current-source receipts,
wrong-subject resolution, source-grant and ACL revocation, clean/poisoned pairing,
fixed-destination rejection and idempotent cleanup. Three admission regressions
cover release/idempotence and preservation of unknown/settled usage. Existing
router and plugin network-policy regressions remain passing.

## Verification and limits

On Node 26.11.1/macOS arm64, the five focused suites pass **172 tests**. Root and
web TypeScript checks and affected strict ESLint pass. The full mandatory
pre-push gate and exact-head/main CI are separate delivery evidence; this report
does not assert them before execution. A type-only Undici-to-web Response boundary
assertion is necessary when the real backend is checked under the web DOM lib;
network behavior, headers, response bodies and policy checks are unchanged.

Provider completions and their token counts are synthetic. They do not establish
model safety, quality, latency, factual correctness or cost. A controlled unsafe
provider proposal followed by a backend block is a successful application control,
not a safe model response. No actual model provider, production booking or shared
budget is used by these tests; their independent memory ledger is explicit.

Snapshots are ingested directly; source-adapter acquisition is not exercised here.
Only the allowed/private Service-IT documents are populated; the required companion
Intranet snapshot is empty. This is not full source-family coverage. Document
metadata uses public classification; the explicit local TestIdP route uses the
synthetic-demo deployment ceiling. The eligibility case proves that conservative
ceiling check, not dynamic per-document classification or institutional processing
approval. Full per-profile source/tool injection and workflow observations,
reviewed/adjudicated cases, approved thresholds and human review remain M6 work.
CACHE-A1 remains deferred to M8-A10 under Plan V9.
