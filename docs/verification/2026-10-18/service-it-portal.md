# Service IT synthetic portal verification

Verified on 2026-10-18 after deployment of `hasi-service-it-demo` (Coolify service UUID `j7goahf7ftvlpvjfaefsdtmj`). The portal is available at [service-it.hasi.metaneutrons.cc](https://service-it.hasi.metaneutrons.cc) behind the existing campus-only Traefik IP allowlist.

The portal serves 271 synthetic Service IT records: 30 legacy demo records plus 241 generated records. Its service, FAQ, and news views read the shared catalog, so future synthetic Service IT fixture additions appear without a fixed-count UI change. Every page identifies its content as fictional, including employee and administrator examples. The article adapter keeps each source title and text inside `main#service-it-document`; the title and paragraph text remain the article’s only semantic content.

The running container reports `healthy` and uses image `sha256:054b87a766399ac666428608d21eecd8395f781cb6fc61cd180393bc5bd80bac` (`linux/amd64`). The rendered Traefik router uses the `https` entrypoint and `service-it-campus-only@docker` middleware. Docker inspection showed no host port bindings (`{}`); container port `4110/tcp` has no published mapping. The Coolify service directory is mode `0700` and its `.env` file is mode `0600`.

Access checks returned:

| Request source | Result |
| --- | ---: |
| Server-local HTTPS request with normal certificate validation | 200; TLS verification succeeded |
| External IPv4 request | 403 |
| External IPv6 request | 403 |
| External IPv4 with `X-Forwarded-For` spoofing | 403 |
| External IPv4 with `Forwarded` spoofing | 403 |
| External IPv6 with `X-Forwarded-For` spoofing | 403 |
| External IPv6 with `Forwarded` spoofing | 403 |

The campus-positive check remains pending because no campus client was used during this verification.

## HASI HTML integration

The HASI runtime was rebuilt from application commit `d05252f` and deployed as
`hasi:service-it-d05252f` (loaded image identity
`sha256:4ce70d4b4be2807d300e9d06e16dd5433f51b20f9f0e0cebdea9409f6277a32c`).
The operator-only fixed-origin setting activates the existing HTML adapter.
The local reviewed inventory ranks candidates; only the selected Service-IT
articles are fetched. An unavailable or changed page fails closed rather than
silently returning embedded fixture text. Intranet demo retrieval remains on
synthetic fixtures; this change does not connect real HsH sources.

Twelve deployed HTTP requests passed with normal TLS verification and zero
model calls: anonymous denial, signed MCP search with `acquisition.adapter=web`,
a newly inventoried RSS article with matching acquired text/current fetch time
and source revision, the authenticated fixed-origin source redirect, stale
revision rejection, student denial for admin-only Service-IT/Intranet examples,
and admin retrieval of its synthetic Service-IT article. Groq remained the
default and GWDG remained configured for manual selection; this check did not
repeat inference qualification. The shared budget retained seven reservations
and 17,591 microUSD of conservative charges across the application/database
restart. This is admission accounting, not a provider invoice.

The generated addition contains 241 entries: 183 authenticated FAQ topics plus
one public RSS supplement, 22 service overviews, eleven news examples, nineteen
link guides and five form guides. One category landing and five broken source
references are excluded. Text is synthetic; source bodies, browser cookies,
real contacts and original source URLs are absent from the generated fixture.
The combined corpus has 301 documents, including the unchanged 30 Intranet
fixtures and 30 earlier Service-IT examples.

Focused portal/adapter/source-authorization tests, all 728 local tests with
isolated PostgreSQL 18, lint, type checks and the Linux amd64 web image build
passed. Chromium screenshots at 390×844 and 1280×900 showed usable layouts;
these are viewport checks, not actual iPhone/Android acceptance. At the first
hosted candidate `095f3c5`, both Node matrix entries passed 727 cases but failed
the existing cold-store offline reference-plugin packaging case. That failure
is tracked under P6 #74; it is not a Service-IT assertion failure or a waived
required CI gate. PR #78 remains unmerged pending qualification.

The packaging wrapper suppresses pnpm stderr, so the current hosted run does
not identify the precise offline failure category. Prior P6 reproduction points
to missing offline package metadata, but that is a hypothesis for this run.
The next bounded action is sanitized category diagnostics and a reproducible
cold-store packaging fix; an unchanged retry does not resolve that obligation.
