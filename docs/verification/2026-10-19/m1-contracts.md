# M1 technical identity and integration contracts

Date: 2026-10-19. Scope: technical M1 #48 under the adopted
[MVP exit criteria](../../plans/hasi-mvp.md#delivery-sequence-and-exit-criteria)
and [institutional transfer](../../plans/hasi-mvp.md#transfer-of-the-original-m1m7-institutional-requirements).
Baseline: main `c98b7c29f08e4e42daa55294dddf9c157a24d326`.
This is a criterion-to-evidence review, not permission to use real HsH data.

## Contract and evidence map

| Boundary | Reference contract and authority | Positive and negative technical evidence |
| --- | --- | --- |
| Institutional identity abstraction | `apps/api/src/oidc.ts`, `identity.ts`, `test-idp.ts`: verified issuer-scoped subject, approved claim mapper, PKCE transaction and current authority resolver | `tests/oidc.test.ts`: verified Test-IdP flow, subject/issuer isolation and stability, invalid nonce/issuer/audience/time, transaction replay and return binding, current authority downgrade/denial/outage; this delivery adds separately signed tokens omitting each required claim |
| Plugin identity projection | `packages/plugin-sdk/src/manifest.ts` and `invocation.ts`: versioned declarations, allowlisted typed claims and signed invocation context; browser/model input never supplies authority | `packages/plugin-sdk/tests/plugin-contract-v2.test.ts`: minimal actor projection, required/optional claim validation and signed context; this delivery adds duplicate declaration and duplicate string-array rejection |
| Intranet reference source | `apps/knowledge-plugin/src/institutional-contracts.ts`: explicit `intranet` source identity, subject/group ACLs, revisions, freshness and signed acquisition records | `tests/institutional-knowledge.test.ts` and `tests/knowledge-pilot-boundaries.test.ts`: allow/deny before retrieval, subject-bound contexts, fresh authority, source deletion/revision/rights changes, denied citations and retained-context revalidation |
| Service-IT reference source | The same shared signed-source contract with distinct `service_it` source identity; configured MediaWiki/HTML acquisition is separate from end-user ACL authority | The same source-specific suites plus `tests/content-adapters.test.ts`: configured acquisition, deny/quarantine on missing review/rights, signed snapshots, per-source revision fencing and incident expiry; live synthetic portal evidence remains in the dated M3 records |
| Anny account and rights abstraction | `apps/api/src/plugin-accounts.ts`, `registry.ts`, `apps/anny-plugin/src/index.ts`: verified host subject, one-use account consent, live account-authority resolution, current customer/resource/service grants and independently confirmed writes | `tests/plugin-accounts.test.ts`: subject/install binding, replay denial, authority revision/change/revocation/outage; `tests/anny-cancellation.test.ts`: own-customer lookup, foreign-customer denial and resource recheck. Full two-user read and unknown-write workflow qualification remains M4/M5, not a new M1 claim |

The transient login transaction, browser persona choice, email string, source
body and model/tool assertions do not grant institutional rights. A successful
mock login establishes only the synthetic technical identity contract.

## Omitted and duplicate claims

Each missing required OIDC field (`iss`, `sub`, `aud`, `exp`, `iat`, `nonce`)
is tested with a signed response from the loopback-only Test-IdP and must fail
before authentication completes. The omission option is constructor-owned fixture
configuration; no HTTP/browser switch controls it. Existing valid tokens remain
the positive control. Duplicate manifest claim declarations and duplicate values
in string-array claims must fail schema validation; valid claims remain accepted.

## Qualification state

Local qualification passed on 2026-10-19: 81 tests across the seven mapped
OIDC, plugin-contract, source-boundary, institutional-knowledge, account-lifecycle,
Anny-cancellation and content-adapter suites; full TypeScript typecheck passed.
The worker separately ran the 39 focused identity/SDK cases. Root repeated the
complete mapped set after integration on current main. Exact candidate CI and
the final acceptance decision remain in #48; local success does not claim them. M1 implementation and contract design are distinct from the larger
M2 plugin/device/runtime qualification matrices.

## Institutional assumptions transferred intact to M8

- HsH issuer, stable claim release, role/group lifecycle and institutional owner
  approval must be verified independently of the Test-IdP.
- Real Intranet/Service-IT machine acquisition, effective end-user ACLs,
  revocation freshness and authoritative incident semantics need source approval.
  A personal Safari session is not a server service identity or rights contract.
- Real Anny account linking, customer token delegation, community/service
  eligibility and create/cancel/reconciliation semantics require tenant/vendor
  qualification. The approved read-only catalog token grants no live write rights.
- Provider processing approval, protected-data retention and institutional
  go/no-go remain M8. No credential, personal page body or real booking is
  needed for technical M1 acceptance.
