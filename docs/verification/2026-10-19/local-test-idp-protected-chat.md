# Local TestIdP protected chat repair

Date: 2026-10-19. Baseline: `abd76038387b39c7342385473a5c56c6766c5afb`.
Scope: one M2 browser-composition repair, not complete M2/P2/P6 or M7 acceptance.
The delivery PR and issue #49 identify the qualified commit and subsequent CI.

## Observed failure and repair

The documented local `--preview --test-idp --plugin-apps` stack completed OIDC
login, then showed “Geschützte Chats konnten nicht geladen werden.” Its
`/api/chat/workspace` request returned 404: the UI correctly selected protected
storage for OIDC, but the BFF only exposed that storage in production mode.
No production failure was inferred from this local observation.

The local launcher now requires an explicit disposable loopback PostgreSQL
`hasi_topology_test` database and creates a private signing secret and UUID
scope for the web process. An explicit server-only local mode uses the same
subject-bound protected store, CAS and current source/history revalidation.
Its core transport is pinned to `http://127.0.0.1:4100`; the web origin is
literal loopback on port 3001 or 3002. Vercel, public-demo mode, arbitrary
origins/databases, missing signing material and missing scope are rejected.
Production configuration still requires separate HTTPS origins and its full
approved data policy, even if the local flag is accidentally present.

The authenticated local development API explicitly reports `synthetic_demo`.
The web checks that server response against its synthetic-only policy; it does
not infer data classification merely from the local flag. A mock persona or
an API reporting confidential context is rejected before protected storage opens.
Credentials and configuration remain server-owned; browser input cannot select
the endpoint, database, signing material or data policy.

Each launcher run creates a fresh synthetic scope. Test records remain under
normal expiry in the supplied disposable database; this is not production
identity, deployment persistence or cross-launch migration evidence. The public
demo's secret, database, budget and browser-transcript policy are unchanged.
The sidebar and delete dialog now describe the actual protected storage rather
than incorrectly saying every OIDC transcript lives in the browser.

## Qualified observations

The new README command block was executed with its required test database on
Node 24.21.0 and 26.11.1, against local PostgreSQL 18.6. The actual API and
Next.js listener executable paths/versions were checked, rather than inferring
Node version solely from the caller shell. Both fresh stacks completed real
TestIdP/OIDC browser login and restored a newly typed synthetic draft after a
full page reload. The protected-server-storage notice was present. The Node 24
flow also returned through the administrator overview; that bounded navigation
is not a full installation/configuration lifecycle test.

A prior Node 26 production-built preview also restored a draft and displayed
native room results. A legacy browser entry for the fixture subject already
existed from earlier work; the new draft was not present in that entry. The
entry was left untouched. This observation is not relabeled as proof that no
legacy key existed. The protected provider continues to use its in-memory
client buffer plus server persistence; no browser-storage fallback was added.

At 390×844 CSS px, the corrected session drawer displayed the server-storage
notice and restored draft. DOM and CDP layout/visual viewport dimensions were
390×844 with document width 390. Escape closed the drawer and restored focus to
“Unterhaltungen anzeigen”. The ordinary browser screenshot adapter produced an
inconsistent scaled capture; a tab-scoped CDP screenshot at the actual CSS
bounds was visually inspected instead. All temporary viewport overrides were
reset. This is one simulated width, not the full P6 or native-device matrix.

The six focused configuration, protected-store, current-history and profile
policy suites passed **42 tests on each Node 24/26**. Countercases cover unsafe
local configuration, anonymous/mock identity, confidential source classification,
cross-origin writes and cross-subject draft isolation. Root/web type checks,
lint and final production-mode web compilation passed. Actual launcher
counter-probes on both Node versions rejected a missing or wrong database before
any fixture listener opened; all owned listener ports were released after the
positive browser runs. The complete mandatory pre-push
and exact-head/main CI remain separately recorded by the delivery PR; the
focused results do not substitute for them.

No provider credentials were inherited by the local runtime. The browser
explicitly used Dialog-Demo for the read-only room observation; no model POST,
provider generation, business booking/cancellation or budget reset occurred.

## Remaining browser findings

The same run exposed two separate open M2/P2/P6 issues:

1. Own protected-workspace autosave immediately replaces fresh availability
   cards with historical unchecked cards. A future repair must preserve useful
   current interaction state without restoring revoked metadata or trusting
   cached availability for booking execution.
2. The reviewed experimental App resource loaded with HTTP 200, but its bridge
   reached the initialization timeout and made zero app-tool calls. Its initial
   view and interactive performance are therefore not qualified by this run.
   Unreviewed Apps remain no-go and public Apps remain off.

The model-free native search itself made one resource request (42.15 ms) and
six availability requests (19.76–26.65 ms), all HTTP 200; their CDP HTTP span was
74.94 ms. These are single local request/response observations, excluding UI
paint and automation round trips, not a p95 or the ≤200 ms UI gate. Model input
and output tokens were zero because no inference was requested; no token,
cache or billing saving is claimed. The failed App opening retrieved its
resource in 16.80 ms but produced no completed App result. These limited
observations do not complete P2-A1 or the joined plugin/admin/chat journey.

## Tested source identities

| File | SHA-256 |
| --- | --- |
| `scripts/dev.ts` | `3f2d6a26533d9fec85d1b73ba67d0c057d6707f824170ea60114d9c090afed47` |
| `apps/api/src/index.ts` | `95d6ffbcb93051ed58a7fa0f898e018c25ff568d923d475dc61d45c6b663bff6` |
| `apps/web/src/lib/server/core-api.ts` | `b0e53d8db9b1a572666686da883d60ff080fbfea87d41d3dbef66028cbfa1222` |
| `apps/web/src/lib/server/chat-access.ts` | `b3779046c24c909f5f32cbad3d99de6e65f94e7298b369ee2af903c6c8b3a509` |
| `apps/web/src/app/api/chat/workspace/route.ts` | `41c5772627633d90c62fe200538e103071e663d171bf5756e86cf12c9168779a` |
| `apps/web/src/lib/server/history-authority.ts` | `0f1b05738815ba481831eee974356e3494a9c79251d7ffd6e310e2da21990514` |
| `apps/web/src/lib/server/knowledge-context.ts` | `4c54412a18a543a0dca93bbe7f28bc39054be89573265391a7a4807a230c5435` |
| `apps/web/src/lib/server/native-history.ts` | `8f66d308f3ddffb1d20aed006dc87a40db65f142a702d321f0185d414d618b18` |
| `apps/web/src/lib/server/authorized-tools.ts` | `1e7e078981b42f2ffa461f77fe2675e68810482ea08a75a2eeca76d5bceea13a` |
| `apps/web/src/components/chat-session-list.tsx` | `eb27d7beaf539ee0d176134a5cbfa8a5c713a02317b93d1a499bc45424af2e46` |
