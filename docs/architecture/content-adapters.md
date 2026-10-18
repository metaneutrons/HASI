# Content acquisition adapters

Decision: 2026-10-18. The knowledge/content MCP is a single service with multiple
content acquisition adapters. Adapters are not model-callable HTTP tools. The
current implementation includes `mediawiki` (also applicable to BlueSpice's
MediaWiki API) and `web`. The public demo continues to serve fictional fixtures.
No protected HsH API, ingestion credential or embedding processing is activated
merely by deploying this code.

## Boundaries and extension

`ContentAdapter.read(ContentPage, AbortSignal)` returns untrusted extracted text,
canonical URL, source revision, acquisition time, optional source-update time and
image descriptors. It never returns authoritative user rights. A host-owned
`ContentTransport` supplies fixed-inventory HTTPS reads, DNS/IP restrictions,
source-only credential custody, serial throttling, request/body bounds and
shutdown. No source link or model argument expands the inventory. Credentials
are cookie or bearer slots in operator custody; a Safari session is not silently
exported into worker configuration.

`ContentAdapterRegistry` registers a factory and strict configuration schema per
adapter type. `ContentAdapterChain` executes the configured order. A reviewed
adapter can be registered through application code without changing retrieval,
citations or chat tools. The stock operator configuration admits the two bundled
types; a new runtime adapter also needs its reviewed configuration registration.
Configuration cannot import arbitrary code from an npm package, URL or Git repo.
Independent external MCP installation remains the plugin platform's responsibility.

Both mandatory sources can select different adapters. A source's `input` is
exactly one of `signed_export` or `content_adapters`; there is no old flat-config
reader or v1 document migration. Adapter-produced snapshots pass the same
signature, policy, ACL, revision, tombstone and freshness checks as remote signed
exports. Retrieval and the requesting user's source rights are independent of the
chosen adapter.

## MediaWiki / BlueSpice

The operator pins the actual `api.php` URL and every canonical page URL/title.
The HsH endpoint and enabled API modules have not been verified; the adapter does
not guess/discover endpoints in production.

The adapter uses read-only Action API GETs with JSON format version 2 and
`assert=user` when authenticated access is configured. It checks `paraminfo` for
required parse/query modules, fetches page info and revision ID/timestamp, parses
that exact `oldid`, then repeats page info before accepting the result. Canonical
URL, page ID, title and revision must match; automatic page redirects are not
followed. Hidden/missing revision metadata, warning-driven behavior changes,
authentication failures and API errors fail closed.

`oldid` pins the page revision; it does not freeze transcluded templates,
extension output or personalized blocks. Acquired text/image changes still alter
the signed document and its HASI revision. Source owners must qualify any such
content and its effective page/block ACLs before enabling ingestion. Both bundled adapters therefore mark rendered content as requiring an exact `reviews[adapter].digest` in operator policy. That review approves the ACL for the entire extracted aggregate, including templates and extension output; it is not inherited automatically from the parent page. Changed rendered text/images/title or source revision needs renewed review before embedding or publication. This conservative mode does not implement automatic dependency-rights resolution. BlueSpice
namespace roles, page-access groups and the crawler's privileges are not inferred
as HASI end-user entitlements from the rendered page.

Module parameter names are unprefixed in `paraminfo` and combined with its declared prefix (`rv`/`in`) for requests; the official live response was checked on 2026-10-18.

A valid capability response explicitly lacking a required module or parameter is
`unsupported`, which permits the next explicitly configured adapter. HTTP
401/403/**404**, redirects, denied API modules, expired authentication, rate
limits, timeouts, malformed/non-JSON responses and changed pages **never** trigger
API-to-web fallback. If the API is entirely absent, an operator can explicitly
configure `web` as the source's primary adapter rather than reinterpret an
ambiguous error as permission to fall back.

## HTML fallback

The `web` adapter uses the same exact URL inventory and source credential scope.
It parses HTML with parse5 without executing scripts or loading resources. An
operator can pin one container by exact ID, class or tag; otherwise exactly one
main element, or one article if there is no main, is required. Navigation,
headers/footers, forms, executable/embedded markup and explicitly hidden elements
are excluded. Login/password forms anywhere in the response reject acquisition.
Block/list/table boundaries are preserved; character, image and link limits fail
rather than silently truncate. External stylesheets are not evaluated; this is
structural extraction, not a claim to reproduce all browser visibility rules.

Image URLs remain private untrusted review metadata and are never fetched. Any
image in the content area needs an explicit image review bound to the extracted
revision/text/image digest before embedding or publication. The reviewed image
transcripts obey the existing knowledge document bounds. Descriptor digests do not
hash image bytes or establish asset freshness; independently versioned asset
review/OCR remains required for institutional image qualification. PDFs, OCR and binary
attachments need separate adapters/extractors and are not handled as HTML.

A content hash is the HTML source revision. `article:modified_time` or HTTP
Last-Modified can supply a source-update timestamp; an absent timestamp stays
absent. Adapter documents distinguish the HASI index-update time from optional
source-update provenance in the schema, model evidence and source reader.

## Snapshot publication and limits

`ContentSnapshotProducer` reads the complete operator-approved subset serially.
Its policy contains explicit per-page classification/ACLs for the complete extracted aggregate, exact-content review digests, stable subject grants,
`completeInventory: true` and `validUntil`. Missing/expired access policy denies
publication; policy validity may extend at most 24 hours from a run. This ceiling
is a safety bound, not an agreed institutional revocation SLA. The operator must
refresh policy from the authoritative rights process; successful scraping does
not renew it. A deployment needs stricter deadlines where required by its owners.

The complete source subset passes extraction/review and total chunk bounds before any new embedding request. Text is split into bounded Unicode-safe chunks with stable allocated IDs. Changed
chunks/metadata increment revisions. Unchanged text reuses approved embeddings;
all new embeddings reserve/settle against the existing shared USD 1/day ledger.
No additional model, fallback provider or budget reset is introduced. Reviewed
image guidance accompanies each chunk. The 1,000-document per-source limit is
checked without dropping surplus content.

A denied/missing/failed page aborts publication of the whole source and the worker immediately persists a source suspension; old content becomes unavailable before its ordinary expiry. A new complete signed snapshot is required to reopen the source. Refresh epochs prevent an overlapping older acquisition from clearing a later suspension. Deletions
occur only after an explicit operator inventory change; a partial crawl or login
page never becomes a successful empty snapshot. Durable CAS preserves producer
sequence, chunk allocation and monotonic retirement tombstones. Removed IDs are
never resurrected, including after chunk shrink/re-expansion or page removal and
re-addition. Publication expires no later than the earliest acquired-page
freshness deadline or access-policy deadline. There is no heartbeat that merely
re-signs old raw content without current acquisition.

The operator composition in `pnpm knowledge:serve` connects the selected adapter
producer directly to the existing ingestion worker. It still supports fixed
remote signed exports. Both sources must be present and fresh before institutional
search can succeed. The process belongs on an approved institutional/local host;
Vercel's synthetic demo does not gain network access to the HsH intranet.

## Operator configuration

Each `sources[]` item retains `sourceSystem`, canonical `origin`, public key,
`policyRevision`, `maxAgeMs` and optional approved private CIDRs. Choose one input:

- `{ "type": "signed_export", "exportUrl": "https://exports.example.edu/intranet.json", "credentialSlot": "sourceExport" }`
- `content_adapters` with `adapters`, optional `{ slot, mode }` credential,
  `signingKeySlot`, `minIntervalMs` (100–10,000, default 250) and reviewed `policy`.

For example, an adapter chain is
`[{ "type": "mediawiki", "apiUrl": "https://wiki.example.edu/w/api.php", "requireAuthenticated": true }, { "type": "web", "container": { "kind": "id", "value": "mw-content-text" } }]`.
These are illustrative addresses, not a configured HsH endpoint or runnable full
configuration. The policy supplies approved page IDs/URLs/titles, language,
classification, explicit ACLs and current subject grants. Use `pnpm knowledge:inspect` to create a private, non-overwriting review artifact before approving aggregate-content digests; see the [operator workflow](institutional-knowledge-operations.md#configuration). The signing private key
is injected via its custody slot and must match the configured source public key.
No private key, cookie or provider credential belongs in JSON. `ingestionTimeoutMs`
is an explicit overall-source deadline (1 second–1 hour); per-request transport
and embedding deadlines remain shorter. Source policy, inventory and endpoint
changes require operator review/restart; users/models cannot alter them.

## Verification and remaining qualification

Focused tests cover adapter selection, explicit fallback and denied-error
counterprobes, parsing bounds/login rejection, fixed-origin/custody behavior,
revision fences, incremental embeddings, chunk retirement, failed publication
and image/policy quarantine. Synthetic signed adapter output is exercised through
the institutional repository. These checks do not establish working HsH API
credentials, owner-approved rights/incident extraction, provider processing
approval, real-phone behavior or completed M3 acceptance.

Primary protocol references: [MediaWiki parameter discovery](https://www.mediawiki.org/wiki/API:Parameter_information/en),
[page revisions](https://www.mediawiki.org/wiki/API:Revisions),
[revision-pinned parsing](https://www.mediawiki.org/wiki/API:Parsing_wikitext),
[assertions](https://www.mediawiki.org/wiki/API:Assert/en),
[API errors](https://www.mediawiki.org/wiki/API:Errors_and_warnings/en),
[BlueSpice permission manager](https://en.wiki.bluespice.com/wiki/Manual:Extension/BlueSpicePermissionManager)
and [page access](https://en.wiki.bluespice.com/wiki/Manual:Extension/BlueSpicePageAccess).
