# Institutional knowledge operations

Status: runnable operator composition, not an approved HsH connection. Read [knowledge boundaries](knowledge-mcp.md) and [M3 evidence](../verification/2026-10-18/m3-knowledge-pilot.md) first.

## Prerequisites

A source owner must approve both ingestion producers (a HASI-operated scraper is permitted), stable HASI subject mappings, document/block ACL projection (split mixed-access pages into distinct ACL-homogeneous export documents before signing), extraction/transcription checks, revisions, incident freshness and revocation deadlines. The consumer cannot infer these from a privileged browser session. Provision separate source-signing keys and approve the embedding provider/model for public, internal and confidential queries. No live endpoints or paid runs are enabled by sample configuration.

The existing application budget database must already contain the explicitly initialized USD 1/day ledger. `pnpm knowledge:serve` never bootstraps or resets it. Its shared namespace/policy comes from `@hasi/state`; a changed model-price ceiling fails closed on a policy mismatch and requires operator reconciliation. The embedding tariff in configuration is review metadata: an explicit ceiling assertion, not an inferred cost returned by the model. Admission always charges the shared conservative 800,000 micro-USD/million input rate; lowering this metadata does not lower ledger charges. Raising it beyond the ceiling is rejected.

## Website acquisition decision (2026-10-18)

Fabian confirms that direct website scraping is the currently available acquisition
method for both sources; no institutional export API is a prerequisite. A separate
HASI-operated TypeScript acquisition process on an approved local/institutional
host produces the signed internal snapshots consumed below when explicitly configured. Both bundled adapters and the producer are implemented; the actual HsH source configuration remains unqualified. The signed JSON
boundary is HASI's internal ingestion format, not an API the source CMS must
implement. Its signature attests to the configured ingestion operator and policy;
it does not prove that the source CMS issued the content or granted access.

Read-only Safari inspection on 2026-10-18 reached the authenticated Intranet at
`https://intranet.hs-hannover.de/wiki` and the Service-IT landing page at
`https://service.it.hs-hannover.de/de/`. The Intranet identifies MediaWiki/BlueSpice
and exposes page-history links; Service-IT shows a separate login link. This is
page-level reachability evidence, not a complete inventory, anonymous-access
classification of all Service-IT pages, an available machine API, or an ACL audit.
No source bodies or cookies are included in this repository.

The adapter implementation and qualification boundaries are documented in [content adapters](content-adapters.md). Institutional qualification must cover:

- Operator-pinned origins and approved path inventories; bounded serial requests,
  redirect checks and throttling. Never follow login/logout/edit/action links or
  fetch arbitrary model-supplied URLs. An expired login or partial crawl is a
  failed acquisition, not an empty full snapshot that retires every missing page.
- Dedicated source-session custody on the ingestion host. A current Safari
  session permits manual inspection; it is not a production worker credential.
  Browser session values must not enter exports, Vercel, Git, logs or model input.
- Main-content extraction and section/chunk provenance, with independently
  reviewed attachment/image handling. Preserve source revision/change evidence
  where available; `fetchedAt` alone must not be presented as source `updatedAt`.
- Explicit externally maintained document/block ACLs and stable subject grants.
  A successful privileged scrape, path name or page category cannot establish
  visibility for other users. Unknown access rules remain quarantined. Per-user
  collection, if selected, still needs source-side revalidation/revocation rules;
  a cached browser session alone does not authorize later disclosure.
- Verified complete inventories before deletion/retirement, persistent revision
  and tombstone state, a bounded freshness deadline, and reviewed current incident
  extraction. Renew source freshness only after successful current acquisition;
  never re-sign an old scrape to make it appear newly checked.

The existing consumer and MCP contract remain unchanged. For the public Vercel
demo, only fictional/synthetic approved fixtures are served; acquiring protected
pages locally does not authorize publishing their bodies or sending them to a
model/embedding provider. Source-owner ACL/freshness decisions and processing
approval remain M1/M3 dependencies, independent of the acquisition method.

## Configuration

Set `HASI_KNOWLEDGE_CONFIG` to an operator-owned JSON file and `DATABASE_URL` to the existing durable database. Secret values stay exclusively in server process environment bindings named `HASI_PLUGIN_SECRET_*`, preferably injected through fnox/deployment custody. Do not put secrets in the JSON, command arguments, plugin settings, logs or client variables. Configuration is parsed by `scripts/knowledge-runtime-config.ts`; unknown fields fail.

Required JSON fields:

| Field | Purpose |
| --- | --- |
| `scope`, `port`, `allowedHosts` | Institutional index scope, loopback listener port, approved external MCP hostnames |
| `invocationPublicKey` | Core API's Ed25519 public PEM for signed invocations |
| `serviceCredentialSlot` | Logical slot for the core-to-plugin service credential |
| `credentialSlots` | Slot → `{ environmentName, revision }` bindings; versions change on rotation |
| `sources` | Exactly one `service_it` and one `intranet`, each `{ sourceSystem, origin, publicKey, policyRevision, maxAgeMs, input, allowedPrivateCidrs? }`; `input` selects `signed_export` or `content_adapters` |
| `embedding` | `{ endpoint, modelId, dimensions, credentialSlot, allowedDataClasses, approvedInputMicroUsdPerMillion, allowedPrivateCidrs? }` |
| `ingestionTimeoutMs` | Overall-source deadline, 1 second to 1 hour; requests retain shorter bounded deadlines |
| `intervalMs` | Poll interval, 1 second to 5 minutes; agree it with both source owners |

`origin` is the canonical HTTPS source root (include the trailing `/` for an origin root). Export URLs are fixed HTTPS, with no userinfo, query, fragment or authentication path. Private ranges need explicit approval; loopback/protected destinations remain denied. The embedding endpoint ends in `/v1/embeddings`. Its declared processing classes must include all three of `public`, `internal`, `confidential`. Its approved input tariff must be positive and no more than 800,000 micro-USD/million input tokens under the current shared policy. The source snapshots must use precisely the configured embedding model and dimensions. These settings do not authorize an actual provider contract.

For adapter input, use the [current adapter configuration](content-adapters.md#operator-configuration): an ordered adapter list, exact page inventory and current ACL/subject policy with an expiry, plus a signing-key slot. The private ingestion key must match the configured source public key. Both bundled adapters produce rendered content, so the complete extracted page needs an exact per-adapter `reviews[adapter].digest` approving its aggregate ACL, including embedded wiki/extension content. Unknown/changed review digests stop before embeddings; all source pages are checked before any new embeddings. Images additionally require reviewed transcripts bound to the same digest.

Create a private review artifact without a database, embedding or model call after configuring source custody:

```sh
pnpm build:backend
HASI_KNOWLEDGE_REVIEW_SOURCE=intranet \
  HASI_KNOWLEDGE_REVIEW_OUTPUT=/private/tmp/hasi-intranet-review.json \
  pnpm knowledge:inspect
```

`HASI_KNOWLEDGE_CONFIG` must already point to the reviewed operator JSON. The output must be a new path outside the repository; the command creates it with mode 0600 and will not overwrite it. It contains protected extracted content and image descriptors for local source-owner review, not public demo fixtures. The digest binds adapter, page ID/URL, classification, language, effective ACL, policy revision, exact extracted content and any configured reviewed image records. Broadening rights, retargeting content or changing an image annotation needs a new approval.

For a page with images, first review its extracted content and descriptors. Enter the approved `images` records into that page's `reviews[adapter]` policy in the same order as the extracted descriptors. Then run inspection again with a new private output path: its `contentReviewDigest` now includes those exact transcripts, IDs, alt text and review/instructional flags. Review the new artifact, including any source change since the first inspection, before copying its digest into `reviews[adapter].digest`. A digest captured before adding transcripts does not approve those transcripts. Programmatic operator tooling must likewise pass the approved image records as the fourth argument to `contentReviewDigest`; ingestion never recomputes an approval on the operator's behalf.

Separate adapter entries can preapprove a primary and fallback independently. The inspection command does not approve access or automatically copy digests into policy. It does not fetch image bytes or perform OCR; the operator must review image guidance against its source. Do not upload the review artifact to Git, Vercel or a model. In deployments without `/private/tmp`, choose an equivalent private operator directory.

After reviewed configuration and custody provisioning:

```sh
pnpm build:backend
pnpm knowledge:serve
```

The service binds **127.0.0.1**, not a public plaintext interface. Place an institutional HTTPS reverse proxy in front, preserving the approved Host header; register its fixed MCP URL and reviewed manifest digest in the core's plugin catalogue. Core invocation signing and the service credential must match this configuration. No new plugin is automatically installed in the institutional core or enabled for users. API `knowledgeOriginalOrigins`, if overridden, must match the approved source origins.

A failed refresh persists a source suspension and denies reads immediately; a fresh complete signed snapshot and an unchanged refresh epoch are required to reopen it. This also prevents an overlapping pre-denial refresh from clearing a later suspension. Revision/tombstone history is retained through suspension.

The worker and MCP server share `institutional-knowledge:shared:v1` PostgreSQL state, separate from the model-budget namespace. No memory fallback exists in this launcher. Polling can start with an empty index, but search fails closed until both approved signed exports are present and fresh. SIGINT/SIGTERM stop polling, abort requests and close pools/transports. The composition serves the same manifest as the demo; synthetic fixtures are never substituted for missing institutional content.

## Qualification and recovery

Use synthetic signed exports and fake embedding transport for development. Before protected deployment, prove denied titles/snippets/images/citations, wrong-subject contexts, mid-request revocation, deletion/old revisions, stale incident/source feeds, signature/key/policy mismatch, worker failure/recovery and unknown embedding usage. Test the complete DE/EN case set with source owners and the approved model. Verify session/device behavior and the reverse proxy, source links and Postgres restore under the actual institutional topology.

A malformed/stale export leaves the previous committed snapshot intact, but it ceases to be usable at its freshness deadline. Repair the source producer and publish a greater sequence; never extend expiry locally or strip its ACL. A key/policy change requires explicit operator provisioning. A provider outage stops semantic retrieval; there is no implicit external fallback. Do not delete or recreate budget state to recover an outage.

No live HsH ingestion configuration/custody, PDF/OCR toolchain, source-owner case approval, institutional processing approval, retention/revocation SLA or production restore exercise is supplied by this repository checkpoint.

## Signing-key rotation and index epochs

No implicit old-key trust or snapshot migration exists. Replacing a source key
in place intentionally rejects old stored snapshots, including as an ingestion
predecessor. Plan rotation as an explicit **new index scope/epoch**:

1. Pause new knowledge requests and drain the worker. Preserve the shared
   model-budget namespace/policy and existing spending state.
2. Provision a new repository `scope`, the reviewed new source key(s) and policy
   revision(s), plus a new opaque document-ID namespace for this epoch. Never
   recycle old document IDs or revision citations.
3. Publish fresh complete exports for **both** sources into that empty scope,
   including current subject grants, homogeneous document ACLs and retirement
   tombstones. Verify signatures, freshness, denied access, old-ID denial and
   expected original links before enabling traffic.
4. Source-key/scope bindings in authority fences invalidate old context receipts.
   Old source IDs remain unavailable. Retire old-scope source records using the
   operator's approved retention/backup procedure; do not clear shared budget or
   account/booking state. No runtime request performs this deletion.

Within an epoch, every removed document ID must be added to the signed
`retiredDocumentIds` set. That set is monotonic; a retired ID can never reappear,
including at a higher revision. Re-publishing removed content requires a new ID.
A full export cannot silently drop tombstones. This preserves old-citation
invalidation across delete/re-add sequences.

The launcher sets PostgreSQL statement/query deadlines. Shutdown drains any
active ingestion before closing transports/pools; a forced process kill can
interrupt an operation, whose snapshot CAS remains atomic. After restart, read
only committed signed snapshots and publish the next monotonic export; never
manufacture a successful ingestion outcome.
