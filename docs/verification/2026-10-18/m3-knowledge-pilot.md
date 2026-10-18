# M3 knowledge implementation and qualification ledger

Date: 2026-10-18. Tracking: [M3 #50](https://github.com/metaneutrons/HASI/issues/50), [M1 #48](https://github.com/metaneutrons/HASI/issues/48), [MVP #47](https://github.com/metaneutrons/HASI/issues/47).
Acceptance authority remains the complete M3 row in [the MVP plan](../../plans/hasi-mvp.md). M2's final-test deferral is not applied to M3. M3 is **not accepted or complete** at this checkpoint.

## Implementation and remaining evidence

| M3 criterion | Executable implementation / offline evidence | Still required for institutional acceptance |
| --- | --- | --- |
| Approved ingestion, both sources | Signed full-export schemas and Ed25519 verification; monotonic source/document revisions, pinned origins/model/dimensions, current subject grants and explicit ACLs; atomic durable-store CAS; bounded polling worker and separate operator composition | Approved actual Service-IT and Intranet acquisition configuration/custody, block-level ACL/extraction semantics, inventories, keys, operator deployment and source-owner approvals |
| Language handling and hybrid retrieval | German/English lexical normalization, BM25 + cosine reciprocal-rank fusion after ACL filtering, fixed budgeted embedding client, no mock semantic fallback | Approved real embedding/model processing and tariff; curated source-owner-reviewed DE/EN/cross-language relevance/answer cases |
| Source references | One current fixture/institutional MCP contract; exact revision citations and authenticated reader/original redirect; no synthetic-to-real redirects | Original HsH URL/revision mapping and actual SSO/proxy behavior |
| No unauthorized snippets or metadata | API→registry→signed MCP→signed export integration test; denied title/body/image/citation markers, wrong-subject context and direct-source denial; ACL checks before lexical/vector ranking | Relevant M1 stable identity/source contracts and M2 foundation qualification; actual two-user rights matrix |
| Revocation, retained context/caches | Signed subject/installation context receipts, current before/after fences, host proofs for derived answers, revalidation on every provider attempt and after generation; OIDC-only signed PostgreSQL workspace path, no protected localStorage; CAS/conflict/failure tests | Source-owner retention/revocation SLA, actual rights-change propagation, institutional PostgreSQL/restore and mobile session qualification |
| Current incident updates | Full snapshot replacement, signed source freshness, incident validity deadline; expired incident bodies withheld, no stale-source fallback; unchanged heartbeats preserve valid retained evidence | Real authoritative incident feed/export, owner update/freshness deadlines and observed outage/update/recovery cases |
| Instructional images | Unreviewed instructional images quarantine the document; only reviewed text transcripts/alt text enter retrieval/context/reader; denied metadata tests | Approved extraction/OCR/transcription production pipeline and source-owner instructional-image checks |

## Security details and deliberate bounds

The public demo continues to use 60 entirely fictional documents. Mock audience claims establish no institutional access. The institutional repository consumes a source-signed export contract; it does not scrape privileged browser sessions or derive ACLs from an ingestion account. It has no cross-user answer/retrieval cache. The separate operator process is dormant unless explicitly configured, has no memory fallback and cannot bootstrap/reset the shared USD 1/day budget.

Retained production model text must match its host HMAC, subject/conversation and dependency closure. Timestamp proofs are independent and cannot authorize it. Knowledge tool bodies are rebuilt from fresh receipt resolution. Browser-carried Anny/dynamic-plugin bodies are replaced by a host notice in production retained context: a signed tool call alone does not authenticate its result. Their UI cards remain available; generic retained read-result receipts are not implemented by this checkpoint and must be qualified with the relevant integration. No prepare/write action is replayed during history validation. Provider projections exclude host provenance metadata. Generic client/API envelopes retain their reviewed provenance/pagination role.

Workspace, reference receipt and derived-proof retention is capped at 30 days as an implementation default awaiting institutional approval. Source validity/ACLs are still checked on each reuse, not trusted for that retention period. Idle workspace refresh runs on focus/30-second intervals, skips busy/unsaved work and hides retained protected content on verification failure. This is not a guaranteed 30-second source revocation SLA. Source readers hide their old body during revalidation. A rights change after provider dispatch cannot recall already-disclosed bytes; the post-generation check prevents showing a now-invalid answer.

The pre-release fixture protocol intentionally has no v1 compatibility path. Public-demo plugin configuration starts in a new registry generation. Budget usage, account state and simulated booking data are not reset. Historical reports remain evidence for their own commits, not promises to load old contracts.

## Verification record

Development tests use fictional signed exports, isolated stores and fake embedding transports/credentials. They make no provider call and do not consume a new paid allowance. Focused suites cover source signature/replay/staleness, ACL-before-ranking, exact revisions, deletion/grant changes, incident expiry, reviewed images, unchanged heartbeat stability, context/body/classification/subject tampering, provider-dispatch denial with zero never-started usage, worker bounds/recovery and embedding accounting.

Local build, lint, typecheck, full coverage and browser results are recorded with the implementation PR/issue. The optional PostgreSQL integration cases require `TEST_DATABASE_URL`; absent local configuration is a skip, never a database acceptance claim. The CI Node 24/26 matrix supplies PostgreSQL and must pass at the candidate head. Source-owner cases and real-device acceptance are separate from those development gates.

Local checkpoint after the review fixes:

- `pnpm build`, `pnpm lint`, `pnpm typecheck`: passed.
- `TEST_DATABASE_URL=<disposable local socket database> pnpm test:coverage`: **663 tests passed in 76 files, no skips**; statements 78.72%, branches 74.80%, functions 87.24%, lines 86.32%. The local database was PostgreSQL **16.15**, isolated on a Unix socket with no TCP listener or existing institutional state. This includes two-pool workspace persistence/CAS and persisted source revocation. CI separately qualifies PostgreSQL 18 on Node 24/26.
- WebKit and Chromium headless checks: 12 allowed-source combinations (320/390/768 px × light/dark), two denied-document cases and two focus-revalidation cases. No horizontal page overflow, correct revision citation, no synthetic original redirect, hidden old body while validation is pending, no denied article and **zero model POSTs**. [Machine-readable checks](m3-browser-checks.json). Screenshots were visually inspected; native iPhone/Android qualification remains open.
- Independent reviews found and corrected expired-incident body delivery, unauthenticated retained non-knowledge tool bodies, provider-facing host metadata, delete/re-add citation reuse and worker shutdown during ingestion. Explicit new-scope/new-ID signing-key rotation is documented and tested; no implicit old-key trust exists.

## External dependencies and next action

M1 still lacks approved source inventories/export/access/revocation contracts for both mandatory sources and released institutional identity/source mappings. No protected source content or credentials were copied into this public checkpoint. The first Safari inspection was unavailable while the Mac was locked. Later read-only inspection on 2026-10-18 reached the authenticated MediaWiki/BlueSpice Intranet and the Service-IT landing page with its separate login link. No source bodies or cookies were copied; this establishes page reachability, not an ACL contract or complete inventory. The existing source research establishes neither a production Intranet connector nor an authoritative incident feed.

Fabian confirms direct website scraping as the current acquisition route. A CMS export endpoint is not required: HASI must implement the local/institutional acquisition producer for its internal signed snapshots, under the [documented acquisition limits](../../architecture/institutional-knowledge-operations.md#website-acquisition-decision-2026-10-18). The current implementation now includes MediaWiki/BlueSpice and HTML adapters, an explicitly reviewed snapshot producer, a private inspection command and direct worker composition. Live HsH configuration, current effective rights and institutional qualification remain open.

Next: provision and qualify website acquisition; source owners review stable subject projection, source ACL/rights-change behavior, incident updates, extraction/image checks, DE/EN cases and approved processing/retention policy. Run institutional and real-device qualification against that configuration. Keep #50 open and use non-closing implementation references until every M3 criterion is evidenced.


Hosted qualification of implementation commit `3f759a6754cbddb9058c39338372f431979fb1a1`:
[CI run 39154655852](https://github.com/metaneutrons/HASI/actions/runs/39154655852),
attempt 2 on the unchanged head, passed all required gates including Node 24/26
and PostgreSQL 18. The first Node 24 offline reference-artifact failure and bounded
cold-cache reproduction remain tracked in [P6 #74](https://github.com/metaneutrons/HASI/issues/74);
no packaging/gate change was made. Vercel Preview
`dpl_6dtPGmWwQbnGbLVreeqmhGoffvEg` was READY and passed eight HTTP smoke checks
without model calls. This documentation-only acquisition clarification does not
claim a new scraper or institutional runtime qualification.


## Content adapter checkpoint (2026-10-18)

The same knowledge MCP now supports multiple source adapters through the typed
`ContentAdapter` port and a registry of reviewed factories/configuration schemas.
The bundled MediaWiki/BlueSpice adapter discovers capabilities, pins root revision
reads and checks before/after page identity; `web` is an explicitly configured
fallback or primary for fixed inventories. An authentication/access failure,
HTTP 404, redirect, malformed payload or outage never authorizes fallback.

All rendered content needs a per-adapter approval digest binding page identity,
canonical URL, complete effective ACL, classification, language, policy revision
and exact extracted text/image descriptors. This includes transcluded wiki and
extension output: the root revision does not prove their rights. Separate primary
and fallback reviews can be provisioned. Unknown/changed approvals stop before
any embeddings. The complete source subset passes acquisition/review and chunk
bounds before embedding begins. PDFs/OCR and independently versioned image assets
remain separate qualification; a descriptor digest is not an image-byte hash.

The direct producer preserves current signed contracts, durable chunk revisions
and retirement tombstones, reuses unchanged embeddings, and shares the existing
USD 1/day ledger. Source-policy validity and earliest page freshness bound snapshot
expiry. Failed refreshes persist source suspension; existing/new repository
instances deny reads before normal snapshot expiry. A successful new signed
snapshot and unchanged refresh epoch are required to reopen it; a refresh begun
before a later suspension cannot clear that suspension.

`pnpm knowledge:inspect` performs source-only acquisition into a new private 0600
review file outside the repository, without model/embedding/database activity.
`pnpm knowledge:serve` accepts current discriminated `signed_export` or
`content_adapters` input per source. There is no old flat-configuration reader.
The unreleased demo registry generation is `knowledge-content-v2`; spending,
accounts and simulated bookings are preserved.

Validation after adapter integration:

- Full build, lint and typecheck passed.
- Disposable local PostgreSQL 16.15 coverage run: **697 tests passed in 81 files,
  no skips**; statements 79.36%, branches 75.34%, functions 87.76%, lines 87.01%.
  The isolated Unix-socket database was stopped and removed afterwards.
- Adapter, parser, transport, producer and persisted-suspension tests include
  positive and denied counterprobes; expanded-content review, copied approval
  after ACL broadening/URL retargeting, fallback ordering, failed source refresh,
  stale refresh fences, chunk shrink/re-expansion and embedding-call counts.
- Independent review findings were corrected. Official public MediaWiki
  `paraminfo` was queried without credentials to verify unprefixed parameter names
  and declared `rv`/`in` prefixes. No authenticated HsH adapter, embedding or
  conversational model request was made in this integration.

The earlier hosted CI/Preview evidence above qualifies `3f759a6`, before the
adapter addition; final candidate CI is tracked in PR #78/#50. M3 remains open for
actual source provisioning, authoritative rights/freshness, owner-reviewed cases,
processing/retention approval and institutional/device qualification. No merge,
Production rollout, release or container publication is claimed by this ledger.
