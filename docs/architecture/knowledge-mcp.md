# Knowledge MCP and source delivery

Implementation checkpoint: 2026-10-18. M3 [#50](https://github.com/metaneutrons/HASI/issues/50) remains open for institutional contracts and qualification. The demo serves fictional data; no HsH source or embedding endpoint is activated by this change.

## One current contract

`de.hsh.hasi.knowledge` exposes the same current manifest v2/API 2.0.0 contract for the fixture adapter and institutional repository. There is no v1 compatibility reader. `knowledge.search` is model-visible; `knowledge.get_document` and `knowledge.authority_fence` are host/app reads. Installation pins, signed projected actor context, replay protection and strict output validation apply to all three.

Every document carries an opaque source-prefixed ID, `knowledge:<source>:<id>:<revision>` citation, language, revision, text, source update/acquisition timestamps, authority/corpus digests, data class and reviewed image transcripts. Institutional records have `synthetic: false` and a pinned canonical HTTPS URL. Fixtures have `synthetic: true`, `synthetic_demo` classification and no canonical URL. The browser imports the same pure Zod contract through `@hasi/knowledge-plugin/contracts`; no server runtime enters its bundle.

The 60 public fictional documents retain deterministic lexical retrieval. A server-issued namespaced `knowledge.demoAudience` claim filters these fixtures before scoring. The institutional repository ignores that fixture claim and all role/group labels submitted by a browser or model. No private browser capture or research source body is published with the fixtures.

## Institutional ingestion boundary

The operator configures both Service-IT and Intranet, each with its own export URL, canonical source root, Ed25519 public key, policy revision and maximum source age. A source-controlled exporter must deliver a signed full snapshot: monotonic sequence, persistent retired-document IDs, issuance/expiry, current stable subject-to-group grants, explicit document ACLs, revisions, text, matching model/dimension embeddings and reviewed instructional-image transcripts. Missing grants or ACL metadata denies access. Revocation, deletion and content/ACL changes are atomic snapshot replacements using shared PostgreSQL CAS.

The payload is `signedKnowledgeExportSchema` in `apps/knowledge-plugin/src/institutional-contracts.ts`. Sign the UTF-8 bytes of the SDK `digest(snapshot)` with the approved source Ed25519 private key; the envelope contains the snapshot and base64url signature. Keys belong to the source/export operator, not the model or browser. Each source must renew signed freshness before expiry, even when unchanged. Changed document fields, including ACL, require a greater document revision. Removed IDs must become signed retirement tombstones and cannot be reused. Mixed-access pages must be split into ACL-homogeneous export records before signing; a single document never combines public and restricted blocks. The source sequence always increases. Limits are 1,000 documents/source, four images/document, 4,000 text characters/document, 2,048 embedding dimensions and a 16 MiB snapshot; the worker defaults to a 4 MiB body bound. A larger corpus needs an explicitly designed chunk/export contract rather than silently truncating content.

The worker pins HTTPS destinations and approved network ranges, resolves credentials through operator custody, rejects redirects and bounds response bytes/time. It polls without overlap and obeys bounded Retry-After responses. It cannot derive end-user ACLs from a crawler account. The current code consumes the approved export contract; actual Wagtail/Intranet exporters, extraction and owner approvals are still required. This is not an implemented general website crawler, PDF extractor or OCR pipeline.

## Retrieval, incidents and images

Source grants and freshness are checked before ranking. The institutional index combines BM25 lexical ranks with cosine vector ranks using reciprocal rank fusion; DE/EN normalization is deterministic, while semantic/cross-language quality depends on the approved embedding model and source-reviewed cases. There is no hash-vector substitute or implicit provider fallback. The source export must provide non-zero vectors from exactly the configured model/dimension contract.

The query embedding endpoint is fixed and requires approved processing of the complete deployment's protected-query ceiling, including free text. Its credential stays in custody. The embedding client reserves conservative input tokens against the same USD 1/day ledger as chat before HTTP, settles verified usage and retains unknown-outcome holds. One call, no retries. The admitted tariff must be explicitly supplied and no higher than the current shared conservative input rate; a different budget policy requires reviewed ledger migration, never resetting usage.

Documents containing unreviewed instructional images are quarantined. Reviewed image instructions enter retrieval/context as plain transcriptions with alt text; no remote image, source HTML or script is executed. Incident documents require `active`/`resolved` state and `validUntil`; an expired incident body is withheld until a fresh valid source record arrives. A missing or expired source feed fails closed, including when the other source remains healthy.

## Retained context and revocation

Search creates a signed, subject- and installation-bound context receipt containing references/digests rather than source bodies. Every reuse resolves current source rights and exact document revisions. Opaque authority fences cover effective grants, policy and corpus content before/after reads. Identical signed freshness renewals keep these fences stable; changed rights/content invalidate them. Acquisition timestamp renewal alone does not change the evidence digest. Freshness is still checked on every lookup.

Production model replies carry a separate host HMAC binding their text/tool calls, conversation, subject and dependency closure. Public timestamp receipts cannot authorize old summaries. Before each provider attempt, retry or fallback the host revalidates dependencies; after generation it checks again before returning the answer. Invalid/unsigned retained answers are excluded, and old browser-carried knowledge bodies are replaced by fresh authorized records. A rights change after dispatch cannot recall bytes already received by the provider or user; processing approval and an agreed source revocation SLA remain mandatory.

OIDC workspaces are stored in signed, subject-bound PostgreSQL records with CAS and a 2 MiB bound; protected chat content is not written to localStorage or imported from old local histories. Workspaces, context receipts and derived-answer proofs have a maximum 30-day retention. This is an implementation default awaiting institutional retention approval, not a source-owner policy. Current rights are rechecked on load, save, provider dispatch, focus and a 30-second idle refresh. A failure hides protected retained content. Conflicts and unsaved drafts have explicit UI states. The public fixture demo keeps its local chat storage.

No cross-user retrieval/answer cache is enabled. This avoids using a cache key as an authorization substitute; it is not a claim of zero database/HTTP latency. Source-owner freshness/revocation thresholds, real device behavior and the complete adversarial/model qualification remain open.

## Source delivery

`/sources/:id?revision=N` loads the exact current authorized revision through `/api/knowledge/documents/:id?revision=N`; unauthorized/unknown/changed sources have a generic unavailable response. The page contains no server-rendered source body, uses private no-store responses and repeats reads on focus/visibility and every 30 seconds. It shows timestamps, incident validity and reviewed image descriptions. The reader hides old content while revalidating.

Real original links use `/api/knowledge/documents/:id/original?revision=N`. The core repeats authorization and checks the pinned source HTTPS origin before redirecting. The source's own SSO remains in force. Synthetic documents cannot redirect to an HsH original. No SAML assertion, source cookie or credential travels to the model.

## Operator composition and prototype reset

See [institutional knowledge operations](institutional-knowledge-operations.md) for the separate long-lived MCP/worker process. It is not started by Vercel or by merely adding a provider key.

The public prototype uses a new registry scope generation for the current contract, starting plugin enable/configuration state afresh. Existing budget, simulated booking and account state is not reset. Old manifest state is not migrated or restored for rollback; use a forward fix or an explicitly fresh prototype workspace. Historical verification reports describe their tested commits and are not rewritten as current compatibility promises.
