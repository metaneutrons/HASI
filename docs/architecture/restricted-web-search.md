# Restricted public web search MCP

Date: 2026-10-17. Roadmap requirement and architecture proposal; no web-search
connector, crawler, search account or provider key is implemented by this document.
The mandatory Intranet, Service-IT and anny MVP integrations remain unchanged.

## Outcome and adapter boundary

Offer read-only discovery and reading of public web material only within
operator-defined source scopes. A scope defines approved HTTPS origins/hosts,
anchored path patterns and exclusions. Administrators can maintain regex rules
through reviewed server configuration; clients, models and documents cannot
modify them or introduce new scopes/endpoints. Broad university-host permission
does not establish access to protected Intranet or Service-IT content.

The HASI-owned MCP contract should expose `web.search` (query plus an approved
scope ID) and `web.read` (a short-lived backend-issued result ID). Results include
canonical source URL, title, excerpt, retrieval time and source revision where
available. The server maps result IDs to URLs and policy revision; the model
cannot use a reader as an arbitrary-URL fetch tool. A registry/adapter boundary
allows Brave discovery or a locally indexed corpus without changing chat tools.
Secret references and budgets remain server-owned.

## Service options and recommendation

| Option | Suitable use | Boundary and limitation |
| --- | --- | --- |
| Brave Search API | Fast first adapter for public discovery | `site:hs-hannover.de` includes subdomains; Goggles can further filter discovery. Query text reaches Brave and corpus coverage/freshness depends on its index. The MCP must independently filter every result. |
| SearXNG | Self-hosted metasearch or a frontend for existing local search backends | Open source, but external engines receive queries unless only local backends are enabled. JSON output needs explicit enablement. Upstream `site:` support varies; self-hosting is not a private university index by itself. |
| TypeScript crawler plus Meilisearch or Typesense | Controlled corpus for a bounded set of HsH websites | Crawl approved sources and index locally; search queries need not leave the institution. Operate crawling, extraction, deletion and freshness yourself. A search index is not a crawler. |

Proposed rollout: prototype the provider-neutral MCP with a Brave adapter if
external processing of the bounded public search query is approved. Prefer an
institution-operated corpus where coverage, query confidentiality and revision
control matter. Crawlee's JavaScript/TypeScript crawler supports URL regex/glob
queue filters; these help discovery but do not replace the fetch policy below.
Meilisearch/Typesense are candidate indexes, not yet selected dependencies.
Typesense DocSearch targets documentation sites; it is not automatically a
complete campus crawler. Meilisearch's advertised managed Documentation Crawler
is a Cloud feature, separate from a self-hosted ingestion pipeline.

## Mandatory URL and network enforcement

Search-engine operators and Goggles influence discovery; they are not the
security boundary. Before returning any title, snippet, URL or content to a model
or user, filter it against the active source policy. Do not return unfiltered
provider summaries, totals or cached results as if they were approved results.
Apply the same policy again immediately before every fetch and redirect hop.

Parse URLs with the standard URL parser, normalize host case/IDNA, and validate
scheme, credentials, port, host, path and query separately. Require HTTPS, no
userinfo, approved ports and bounded input. A policy for the apex and every HsH
subdomain can use an exact/dot-boundary hostname check. Its hostname-only regex
equivalent, applied after DNS-label validation, is:

```regex
^(?:[a-z0-9-]+\.)*hs-hannover\.de$
```

This example includes `hs-hannover.de`; deployments may exclude the apex or
narrow to explicitly listed subdomains. Add anchored path allow/deny rules for
particular areas. Validate/compile bounded patterns at configuration time with
a linear-time engine or equivalent complexity constraints. Never apply an
unanchored expression to the raw URL or accept regex supplied by the model.
Deny rules take precedence. Undefined/malformed policy denies access.

Canonicalize and validate path encoding before matching; reject ambiguous
encodings/path traversal and unexpected query parameters. Reject non-HTTP
schemes, IP-literal targets, unapproved ports and lookalikes such as
`hs-hannover.de.attacker.example`. Resolve and validate IPv4/IPv6 destinations
and bind the connection to the validated destination; do not leave a DNS-rebinding
window. This public-web connector must not reach private, loopback, link-local or
cloud-metadata addresses. Authorized internal source adapters remain separate.
Disable redirects by default or revalidate every bounded hop before following.
No cookies, SSO assertions, authorization headers or model-provider credentials
are forwarded to public sources. Enforce egress restrictions independently.

Crawling must apply this policy to seed URLs, discovered links, sitemaps,
robots files, redirects and any browser subrequests. Prefer a simple HTML fetch
pipeline; enabling browser execution must not silently enable third-party
scripts, images or arbitrary network destinations. Respect crawl policies,
rate limits, document sizes, media types, timeouts and source-owner constraints.

## Knowledge handling and acceptance

Public HTML, PDF, OCR and search snippets remain untrusted evidence. They cannot
enable tools, override instructions or establish user rights. Search queries
must be minimized and approved for the selected external processor; do not
forward full chats, personal records or protected excerpts as search queries.
Ingestion can reuse the versioned PDF/OCR knowledge pipeline, original hashes,
page mapping and extraction-quality gates from the examination-regulations
roadmap. Preserve provenance and exact citations. Missing coverage or an old
index must be disclosed; an empty search is not proof that a rule does not exist.

Acceptance requires positive in-scope HTML/PDF searches and negative probes for
lookalike hosts, userinfo, encoded traversal, wrong ports/schemes, redirects,
IPv4/IPv6/private-DNS targets, poisoned snippets, unsafe subrequests and forged
result IDs. Verify policy-revision cache invalidation, source updates/deletions,
no out-of-scope metadata exposure, bounded regex execution and no protected-query
disclosure. Operators must be able to select/swap search adapters and scopes
without deploying plugin code; granting a scope still requires real administrative
authorization. The mock admin must not gain global URL-policy authority.

Sources checked 2026-10-17:
[Brave operators](https://api-dashboard.search.brave.com/documentation/resources/search-operators),
[Brave Goggles](https://api-dashboard.search.brave.com/documentation/resources/goggles),
[SearXNG API](https://docs.searxng.org/dev/search_api.html),
[SearXNG local backends](https://docs.searxng.org/dev/engines/offline/search-indexer-engines.html),
[Crawlee URL filters](https://crawlee.dev/js/api/3.15/core/interface/EnqueueLinksOptions),
[Typesense DocSearch](https://typesense.org/docs/guide/docsearch.html),
[Meilisearch managed crawler](https://www.meilisearch.com/blog/documentation-crawler-release),
[OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
