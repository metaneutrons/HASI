<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hasi-hero-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hasi-hero-light.svg">
    <img src="docs/assets/hasi-hero-light.svg" alt="HASI dialog mark and wordmark; institution: Hochschule Hannover" width="1100">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/metaneutrons/HASI/actions/workflows/ci.yml"><img src="https://github.com/metaneutrons/HASI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg" alt="GPL-3.0-only"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 6.0"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&amp;logoColor=white" alt="Node.js 24 or newer"></a>
  <a href="https://hasi.metaneutrons.cc"><img src="https://img.shields.io/badge/demo-live-46715a" alt="Live public demo"></a>
</p>

<p align="center"><strong>A chat-first campus assistant prototype.</strong><br>
Ask questions, find rooms and prepare a simulated booking in one conversation.</p>

The HASI dialog mark is a product identity; the institution is attributed separately. UI, chat headers, social preview and Apple icon share the geometry in `apps/web/src/lib/hasi-brand.ts`. README and favicon SVGs are generated from that source with `pnpm brand:generate`; `pnpm brand:check` verifies them and also runs before a web build.

## What works today

- **Chat and room workflows:** multiple saved conversations in a collapsible Chats list; safe Markdown formatting and per-message menus for exact Markdown source, source view or content with result cards; new chats start with the operator default (Groq GPT-OSS 120B in the demo); server-issued UTC message times displayed in Europe/Berlin, with unknown legacy times preserved; complete room intervals retained across preferences and guarded against automatic model time shifts; room search, compact progressive results, availability, booking and cancellation proposals with separate explicit confirmation inside the conversation; responsive layouts with light, dark and system themes.
- **Room and workplace catalog:** 61 resources and all 9 services from an authorized, read-only HsH anny snapshot dated 2026-10-16. The demo offers 37 individual workplaces and six meeting rooms; 18 office containers provide context and cannot be booked as a whole. Person capacity is separate from bookable quantity. No lecture halls occur in this snapshot. Availability, access grants, bookings and cancellations remain synthetic. Office filters use the complete parent/desk hierarchy (eight offices with one recorded desk, ten shared offices); six standalone desks have no office classification. See [booking units](docs/architecture/anny-booking-units.md).
- **Knowledge:** one current MCP contract serves 301 synthetic documents (271 Service-IT and 30 Intranet) and a separate institutional repository. The optional demo HTML path reads approved Service-IT bodies from the restricted portal and fails closed on changed or unavailable content. The institutional implementation verifies signed full exports, applies source ACLs before BM25/vector retrieval, rechecks retained context, withholds stale incidents and unreviewed instructional images, and resolves authorized revision links. Protected OIDC chats use server-side CAS storage. MediaWiki/BlueSpice and HTML acquisition adapters share that contract, with explicit fallback, aggregate-content review that binds ordered image annotations, guarded source custody and immediate suspension after failed refreshes. Actual HsH configuration/rights approval and institutional qualification remain open; see [M3 evidence](docs/verification/2026-10-18/m3-knowledge-pilot.md) and [synthetic adapter-chain checks](docs/verification/2026-10-19/m3-adapter-flow.md). [Incident-state and deployed knowledge checks](docs/verification/2026-10-19/m3-incident-transition.md) cover synthetic expiry/recovery, roles, citations and same-workspace context isolation without model calls. Demo documents are not HsH guidance.
- **Model registry:** versioned server configuration supports GroqCloud, GWDG SAIA, DeepInfra, native OpenAI Responses/Chat, Anthropic Messages and multiple OpenAI-compatible endpoints. Operators choose the default, explicitly enable/limit user selection and define bounded fallback rules. Fallbacks are off in the bundled demo; eligible configured fallbacks pin the actual model for the tool turn and never replay business actions. Groq has live demo evidence; GWDG and DeepInfra remain Experimental. Other adapters are mock-transport tested, not live-qualified. Use synthetic test data only.
- **Model efficiency:** room cards end model planning without an extra summary. Simple office preferences and booking-list requests use typed tools directly; card selection and confirmation need no extra generation. Provider context uses a shorter stable instruction prefix, user-only calendar anchors and compact recent anny results. Content-free usage/quota diagnostics help distinguish provider limits; Groq cache counters measure reused versus uncached input tokens when the provider reports them. Controlled live repeats currently return no cache counter; a hit is not yet proven. The operator-only `pnpm probe:groq-cache` compares raw versus SDK usage without logging prompts. See the [context measurements](docs/verification/2026-10-18/groq-context-budget.md) and [cache investigation](docs/verification/2026-10-18/groq-prompt-cache.md).
- **Plugin foundation:** registry-derived tools, v2 contracts, nested/conditional configuration forms, field-level diagnostics and revision-controlled activation. Personal service connections support explicit consent, renewal, disconnect and provider revocation, with current account rights checked before tool calls. Host confirmation previews identify service/account, consequences and costs; an independent status check reads durable execution receipts without replaying writes. Approved plain-MCP adapters, host provenance/pagination envelopes, credential-custody revisions, a shared deployment route/controller and a self-contained reference artifact implement the external-plugin path. The paired relay has local macOS/Colima and Linux native-MCP evidence. A separate local PostgreSQL exercise now covers two gateway processes, update/restart, lost replies, configuration changes, candidate cancellation, rollback and route withdrawal; a separately versioned artifact pair from an independent local repository also passed bounded native-gateway lifecycle checks on macOS/arm64 and Linux/amd64. An actual local managed-worker/API journey also verifies stale pending-action rejection after update, disable/re-enable and rollback, followed by exactly one separately confirmed synthetic action ([bounded evidence](docs/verification/2026-10-20/managed-pending-lifecycle.md)). Complete admin/chat/update/rollback product qualification remains open ([external-artifact evidence](docs/verification/2026-10-19/external-artifact-gateway.md)). MCP Apps stays disabled in the public demo; native results are the default. The reviewed local Anny view loads a fresh authorized catalogue when opened, keeps the requested interval, and uses app-only reads for filters and paging without additional model generations; failed reads remove prior catalogue results. See [contracts](docs/architecture/plugin-contract-v2.md) and [operations](docs/architecture/plugin-operations.md).
- **Model budgets:** a CAS-backed shared USD 1/day admission ledger covers provider attempts, retries and fallbacks. Missing deployed state fails closed and requires explicit bootstrap. GWDG uses an expressly approved temporary Groq-Qwen price estimate, not a verified invoice tariff. See [budget policy and provisioning](docs/architecture/model-budget.md).
- **Test identity:** visitors can select student, employee or administrator demo personas in an isolated workspace. They are fixtures, not HsH identities or institutional permissions. The local `--test-idp` launcher additionally exercises real OIDC redirects, PKCE/state/nonce and signed test ID tokens; it is not institutional SSO.

Synthetic FAQ labels use reviewed complete questions, with document and citation
revisions advanced together. The original demo bodies and access labels are
preserved; historical source links continue to request their exact revision and
are never silently rewritten to a newer document. See the
[title and supplied-dialogue follow-up](docs/verification/2026-10-21/supplied-dialogue-followup.md).

The [public demo](https://hasi.metaneutrons.cc) uses a server-backed runtime and isolated synthetic state. On first use of anny, the chat offers an explicit test-account connection and continues the original request after confirmation; **Verbundene Dienste** also manages connections. HASI does not ask users to supply internal resource IDs to work around missing account access. Disconnecting removes tool access and invalidates pending confirmations; it does not undo an existing booking or delete chat history. Public-demo chat transcripts and profile settings stay in browser storage; the server stores workspace sessions, proposals, integration settings and simulated bookings. There is no live anny tenant, institutional knowledge source or real SSO connection.

In protected OIDC chats, fresh room availability survives an own autosave as a short-lived display observation. It expires after 30 seconds (a pending action in that chat finishes first); reopening or refreshing history always requires a new availability check. Metadata and resource access are reauthorized by the server, and booking still requires its separate current-policy check and explicit confirmation. Other chats keep their drafts and running actions during synchronization. Completed booking and cancellation cards retain their authorized status after saving or reloading; the same card becomes the receipt and links to bookings. An explicit status check updates it without repeating the action. Denied or unavailable current proposal authority removes the retained card and protected display data. A signed server-only reference lets the host reconstruct a fresh authorized receipt after account renewal; old pending confirmations remain invalidated. A free-text success message never establishes completion. See [action-history recovery](docs/architecture/action-history-recovery.md). Host-generated greetings, search refinements and missing-detail questions also survive protected saves. They use separate display evidence and never become model/source evidence or action confirmation. Search-dependent notices and candidate cards are checked against the current authorized catalogue.


In protected OIDC chats, generic read-tool results are invoked by the host and retained as signed, owner- and conversation-bound server records. Saved cards and later model context are reconstructed from those records, with current service rights rechecked; browser-carried result text cannot establish authority. Derived answers depend on those records and are excluded when their evidence is unavailable. Retained results are historical observations and require a fresh read for current conditions. Generic preparation and execution retain the separate proposal and explicit-confirmation boundary. See [result-history design and qualification](docs/architecture/plugin-result-history.md).

Messages support Markdown lists, tables, quotes, emphasis and code. Use the copy
menu's **Markdown kopieren** for the unchanged message source, or **Quelltext
anzeigen** to inspect it. Paste source directly into the composer; indentation
and Markdown hard breaks survive sending and storage. Messages are limited to
4,000 characters; an oversized paste is rejected without truncating the draft.
Raw HTML and remote images are not rendered or fetched.

Knowledge answers show numbered source links matching their cards, with title,
source and revision. Links open the authorized reader in the same tab; **Zurück
zur Nachricht** and browser Back restore the originating chat/message and draft.
Unmatched source tokens are marked as unassigned; IDs remain in collapsed reader
details and the original Markdown source. Evidence selection never grants source
access. See [the bounded UX checks](docs/verification/2026-10-20/knowledge-link-ux.md).

## Run locally

Requires Node.js 24 or 26 and pnpm 12.11.2.

```sh
git clone https://github.com/metaneutrons/HASI.git
cd HASI
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:3001>. Start in **Chats**, describe a room request, choose an available interval and confirm the proposal card to create a simulated booking. **Neuer Chat** starts a separate conversation; saved chats can be switched, renamed and deleted. The new-chat action is disabled while the active chat has no messages or draft; another existing unused chat is reopened before a new conversation is created.

`pnpm dev` builds backend packages, then starts the local multi-process reference stack with in-memory state: the web UI on port 3001, core API on 4100, anny MCP plugin on 4101, synthetic anny HTTP service on 4102 and knowledge MCP on 4103. It creates ephemeral signing keys and service tokens. If a port is occupied, startup stops; it does not stop other services. Stop the launcher with Ctrl-C. To use another UI port, run `HASI_WEB_PORT=3002 pnpm dev`.

For the synthetic OIDC/TestIdP flow, first set `TEST_DATABASE_URL` to an
existing **disposable** PostgreSQL database named `hasi_topology_test` on
`127.0.0.1` with an explicit port. Then run:

```sh
: "${TEST_DATABASE_URL:?Set the disposable loopback hasi_topology_test database URL}"
pnpm build:backend
pnpm exec tsx scripts/dev.ts --test-idp
```

This mode uses the same subject-bound protected server chat store and current
history/source checks as the production path. It generates a local signing key
and scope, stores chat state in the supplied test database, and does not fall
back to browser storage. Each launcher run starts a fresh synthetic scope; old
test rows remain under their normal expiry in the disposable database. The explicitly local HTTP transport is pinned to the
loopback fixture API; production still requires separate HTTPS origins. TestIdP
mode supports web ports 3001 and 3002 and only synthetic data. Ordinary persona
mode needs no database. Neither mode establishes institutional authorization.

To use GroqCloud, GWDG SAIA or DeepInfra locally, provide the corresponding server-side credential in `apps/web/.env.local` or the web server process environment. A profile without its own credential is unavailable; choose another configured profile or explicitly select **Dialog-Demo · ohne Modell**:

```dotenv
# apps/web/.env.local
GROQ_API_KEY=
GWDG_API_KEY=
DEEPINFRA_API_KEY=
```

Paid calls require an exact operator-approved price, either from the bundled Groq/GWDG/DeepInfra entries or an operator-supplied `HASI_MODEL_PRICES` configuration. Custom models have no implicit tariff.
DeepInfra uses the exact `deepseek-ai/DeepSeek-V4.1-Flash` model at its fixed vendor endpoint; its hidden runtime key does not alter the Groq default or enable automatic fallback. See [configuration and qualification limits](docs/architecture/model-provider-configuration.md#deepinfra-qualification).

Live cache probes additionally require the explicitly initialized shared PostgreSQL ledger described in [budget provisioning](docs/architecture/model-budget.md); they do not fall back to a fresh local-memory allowance.

An optional custom OpenAI-compatible profile appears only when `CUSTOM_ENDPOINT`
is a valid HTTPS base URL and `CUSTOM_MODEL_ID` is set. Its own `CUSTOM_API_KEY`
must also be present before the profile can send requests. Configure all three
values in `apps/web/.env.local`; none belongs in a `NEXT_PUBLIC_` variable.
The custom endpoint is pinned server-side and must support the chat-completions
tool protocol used by HASI. Operators must qualify tool calls against their
provider before enabling room workflows. The currently exposed GWDG profile is
Qwen3 30B A3B Instruct 2507; protected Preview checks passed for a cited
knowledge answer and anny room search. GPT-OSS 120B is deferred after upstream
HTTP 500 responses. See [GWDG SAIA and custom providers](docs/architecture/gwdg-saia.md).

Keep credentials private and never commit the file or expose them through a `NEXT_PUBLIC_` variable. The public UI sends messages and selected tool results to the chosen model provider. Do not enter personal, confidential or institutional data.

### Configure models and routing

Use [the example configuration](config/model-providers.example.json) and
[JSON Schema](config/model-providers.schema.json), then validate without any
provider calls or credential lookup:

```sh
pnpm config:models config/model-providers.example.json
```

Set the JSON document contents as server-only `HASI_LLM_CONFIG`. Connections
reference environment-managed secrets; never put keys in the document.
Standard providers use fixed vendor endpoints; custom connections use an
operator-approved HTTPS endpoint. `policy.userChoice.enabled` and its profile
allowlist determine whether users may choose a model, enforced in the backend
as well as the UI. The default applies to every new/replacement chat.

Fallback rules define source, ordered targets and eligible rate-limit/server/
timeout errors. Each target must pass context, native-tool and credential
checks within the attempt/time budget. Invalid configurations fail closed.
The public mock admin cannot edit global configuration or credentials.
See [configuration, fallback examples and qualification limits](docs/architecture/model-provider-configuration.md).
Legacy `CUSTOM_*` settings remain supported when no explicit JSON is supplied.

### Plan a synthetic model comparison

```sh
pnpm evaluate:models --profiles groq-oss-120b,gwdg-qwen3-30b,deepinfra-deepseek-v4.1-flash
```

This is plan-only: no credentials are resolved, database opened or provider
called. Explicit live execution uses the existing router and shared daily
budget, a pinned synthetic corpus and an actual HTTP-attempt cap. Reports
separate provider-reported usage from tariff-based cost estimates and unknown
usage. The bounded citation checks do not establish semantic quality or M6
acceptance. See [operator instructions and measurement limits](docs/evaluation/provider-observations.md).

### Local PostgreSQL server mode

This one-process mode runs the server-backed demo against a local PostgreSQL database. Create a local database and a new 32-byte base64url `HASI_DEMO_SECRET`, then set these values in `apps/web/.env.local`:

```dotenv
NEXT_PUBLIC_HASI_PUBLIC_DEMO=1
HASI_DEMO_MODE=1
HASI_DEMO_ORIGIN=http://127.0.0.1:3001
DATABASE_URL=
HASI_DEMO_SECRET=
GROQ_API_KEY=
GWDG_API_KEY=
DEEPINFRA_API_KEY=
CUSTOM_API_KEY=
CUSTOM_ENDPOINT=
CUSTOM_MODEL_ID=
```

Then run `pnpm --filter @hasi/web dev`. This PostgreSQL mode is separate from `pnpm dev`, which continues to run the multi-process in-memory stack. Do not commit `.env.local` or place secrets in client-visible variables. See [public demo architecture](docs/architecture/public-demo.md) for the runtime and data boundaries.

For an optimized local preview, run `pnpm preview`. It builds the application first and runs the separate local services in production build mode with in-memory demo data. Model calls in production build mode additionally require the explicitly initialized PostgreSQL budget store; select Dialog-Demo when that store is unavailable. It does not enable real SSO or live integration credentials.

### Joined plugin journey fixture

For actual browser qualification with a local TestIdP, two API replicas, personal
synthetic account consent and a separately packaged reference plugin, use
[`pnpm journey:serve`](docs/verification/2026-10-20/joined-plugin-runtime.md).
It requires an explicitly disposable loopback PostgreSQL database and isolated
HOME. Its local model is deterministic and uses no real provider credentials.
The independent reference process retains synthetic execution/source receipts in
a private SQLite file across process and artifact restarts. Explicit terminal
controls inject a lost confirmed HTTP reply, an unknown SDK acknowledgement or a
source outage; these controls are unavailable to models and HTTP clients.
Use `pnpm journey:serve --managed` to replace that direct reference process with
an actual separate managed installer worker, signed private RPC, pinned Docker
images and the deployment gateway. Install, approve, activate, update and roll
back through the existing admin UI. This mode requires a local Unix Docker
socket and the approved base image already present; it never pulls images.
Add `--optimized` to either mode to build the frontend and run `next start`
instead of the development server. The build receives no identity, database,
Docker or model credentials. A separate operator step initializes the existing
budget ledger in the admitted local test database, preserving prior usage.
Run only one local Next build/server at a time because they share `.next`.
Managed reference artifacts now declare the invocation-bound
[managed-state SDK profile](docs/architecture/managed-plugin-state.md) before
packaging and signing. Application state and execution receipts live in the
host's fenced PostgreSQL store, partitioned by installation, subject and the
personally linked synthetic account. Containers have no database credentials
or persistent filesystem mount. The direct fixture keeps its private SQLite
profile. Fixture metadata declares the configured mechanism; starting either
fixture does not establish continuity or product acceptance. The
[stateful lifecycle qualification](docs/verification/2026-10-21/managed-state-container-lifecycle.md)
records actual API/container evidence and its limits. Full joined browser
qualification and independent publication/distribution remain open.
See the [managed browser runtime](docs/verification/2026-10-20/managed-browser-runtime.md)
for isolation, commands, cleanup and the bounded browser observations.
The report records current findings and incomplete journeys; starting the fixture
does not establish M2/P6 acceptance. The [protected action-history follow-up](docs/verification/2026-10-20/plugin-action-history.md)
records the overlapping-save correction and bounded multi-turn browser checks;
the [account-renewal follow-up](docs/verification/2026-10-20/action-history-renewal.md) records signed action references and bounded expiry/renewal checks. Complete product qualification remains open.

## Verify changes

The self-hosted demo's private [deployment controller](deploy/coolify/main-deployment.md)
admits the current `main` revision only after its CI passes, then pins and builds
that exact commit in Coolify. PostgreSQL, test sessions and the shared budget
remain in their existing persistent data resource. `GET /api/health` reports
the ready image revision without a model call. Release Please remains the sole
authority for published multi-platform container releases.

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm research:anny
pnpm reference:prepare
pnpm test
pnpm test:coverage
```

Build first after a clean install: workspace declaration files are emitted to `dist` and are needed by linting, type checks and tests. Integration tests use loopback HTTP and MCP calls. `pnpm research:anny` fetches the third-party anny specifications, verifies their pinned SHA-256 values and materializes them for contract tests; the specifications are not redistributed here.

`pnpm reference:prepare` explicitly prepares the locked reference SDK deployment dependencies online. The subsequent reference artifact packaging stays offline, with lifecycle scripts disabled and the lockfile frozen. Preparation and tests must share the same pnpm store and metadata cache (`XDG_CACHE_HOME` when set); CI prepares a fresh metadata cache for each matrix job.

## Architecture and boundaries

| Area | Responsibility |
| --- | --- |
| `apps/web` | Next.js chat, room booking and administration UI |
| `apps/api` | Server-owned identity, authorization, plugin registry and proposal confirmation |
| `apps/anny-plugin`, `apps/knowledge-plugin` | Room tools and a common fixture/institutional knowledge MCP contract |
| `apps/service-it-demo` | Restricted synthetic HTML portal for Service-IT adapter qualification |
| `packages/plugin-sdk`, `packages/anny-client` | Versioned plugin contract, signed capabilities, and anny HTTP contracts |
| `packages/demo-runtime`, `packages/state` | Co-located server handlers and memory/PostgreSQL JSON stores |
| `fixtures` | Curated fictional knowledge corpus and read-only room catalog snapshot |

The separate `pnpm knowledge:serve` composition accepts approved signed exports or operator-configured MediaWiki/BlueSpice and HTML adapters. New document chunks and queries share the existing embedding budget; unchanged chunks reuse embeddings. `pnpm knowledge:inspect` creates a private local review artifact without model/embedding calls; see [institutional knowledge operations](docs/architecture/institutional-knowledge-operations.md). It is not enabled by the public demo.

A separate production API entrypoint and frontend-to-API transport are available; see [production composition](docs/architecture/production-runtime.md). They require real operator configuration and institutional authority provisioning. The public demo does not use this production identity path.

The separate trusted managed-plugin installer now provides approved-release
staging, manifest preflight, explicit review, activation, cancellation, rollback
and reconciliation through private signed RPC and the admin interface. Docker
access belongs only to that worker. Configuration can be prepared before the
first installation. Deployed lifecycle, independent artifact distribution and
the remaining M2 qualification are still open; this does not enable arbitrary
repository execution in the public demo.

The production host adopts the active contract through a separate authenticated
installer read, including current tool schemas and logical credential readiness.
It does not copy plugin secrets into the API process. A lifecycle revision pins
each gateway request; a stale call cannot switch to a replacement runtime.
Unready or revoked installations stop advertising model tools while unrelated
sources remain usable. [Scope and evidence](docs/verification/2026-10-19/managed-contract-adoption.md).

The [synthetic topology qualifier](docs/architecture/production-runtime.md#isolated-identitytopology-qualification)
runs the actual Next.js handler, two separate API processes, trusted local TLS,
Test-IdP and disposable PostgreSQL. It checks session/revocation/restart boundaries
without a model call. Production request events expose only a server correlation
ID, static route, method, status and duration. The separate
[budget qualifier](docs/architecture/model-budget.md#isolated-cross-instance-runtime-qualification)
checks missing-state denial, concurrent exhaustion and restart persistence across
two real Next.js processes using a disposable database and local fake provider.
[Anny reference tests](docs/verification/2026-10-19/m4-reference-rights.md) exercise
distinct stable subjects and current resource grants through signed MCP and a
contract HTTP mock. Worker isolation, full model evaluation and browser workflows
remain separate gates; these synthetic checks do not authorize real HsH access.

The host owns identity, permissions and state transitions. The model can search and prepare a proposal; only the user can confirm the exact proposal, and the current booking path writes to the synthetic service. Production third-party plugin isolation, source integrations and institutional authorization remain open work.

## Status

HASI is an incomplete MVP prototype, not an operational Hochschule Hannover service. The M2 account/action/deployment implementation is available for qualification; real HsH SSO/account-adapter provisioning, institutional permission mapping, live availability and booking, approved live Intranet/Service-IT acquisition configurations and source-owner qualification, source-specific uncertain-write reconciliation, provider approval and final isolation/native-device qualification remain outstanding. Responsive browser checks do not establish iPhone or Android qualification. The public demo's durable synthetic state does not provide institutional authorization or booking reconciliation.

Versioned GHCR images for `linux/amd64` and `linux/arm64` are built only through Release Please. The workflow and local Compose demo are implemented; no GHCR image has been published, and hosted native qualification is recorded separately in [D3](https://github.com/metaneutrons/HASI/issues/17). See the [container runtime and release boundaries](docs/architecture/container-runtime.md) before building or selecting a release image. Read-only mainline qualification uploads CI artifacts without creating a tag or release.

The roadmap additionally covers [public web search restricted to operator-approved URL scopes](docs/architecture/restricted-web-search.md), Moodle, Stud.IP, HISinOne (including exam registration and student records), SAP leave/time workflows, and a versioned knowledge base of examination regulations for every degree programme, including scanned PDFs, OCR and exact page citations. These integrations are planned, not implemented.

The synthetic demo is disposable and has no backup acceptance requirement; production backup/restore and off-host replication remain final M8-A8 gates. API p95 ≤ 1 second with five concurrent users is deferred to M8-A9; local UI feedback ≤ 200 ms remains in M2/M7. Independent health monitoring and durable session/action/budget controls remain technical requirements.

Technical milestones M1–M7 may qualify with Test-IdP, synthetic content, contract-based mocks and automated/browser/simulator tests. Real-device and participant acceptance is reserved for M8. Real HsH identity, effective source rights, actual Anny conformance and protected-data approvals belong to the final [institutional acceptance M8 #80](https://github.com/metaneutrons/HASI/issues/80). Mock qualification cannot authorize those live integrations. The requested DeepInfra addition is tracked in [#81](https://github.com/metaneutrons/HASI/issues/81); its synthetic-only profile passed bounded deployed chat and Anny-tool checks; formal model evaluation and real-user/data acceptance remain separate.

Track delivery in the [unified index #47](https://github.com/metaneutrons/HASI/issues/47),
later integrations in [roadmap #55](https://github.com/metaneutrons/HASI/issues/55),
and the six plugin qualification groups P1–P6 in [M2 #49](https://github.com/metaneutrons/HASI/issues/49).
The approved [v7 plan](docs/plans/consolidated-delivery.md#v3-issue-graph)
consolidates the initiative into 13 primary tracking records while preserving all acceptance criteria and evidence; completed records close with their evidence in the issue index.
The MCP registry supports approved endpoints, compatible updates, schema-driven
configuration and registry-driven chat tool discovery. Arbitrary plugin code
installation is intentionally unsupported. Independent artifact packaging, personal account lifecycle and deployment coordination have implementation paths. Full mobile/production acceptance remains open; final acceptance tests were deferred by Fabian on 2026-10-18.
See the [MVP plan](docs/plans/hasi-mvp.md) and [server-demo parity criteria](docs/plans/server-demo-parity.md) for qualification scope.

## Project documents

- [Consolidated delivery plan and plugin-platform milestones](docs/plans/consolidated-delivery.md)
- [Chat-first interaction](docs/architecture/chat-first.md)
- [Plugin v2 contracts, administration and MCP Apps feasibility](docs/architecture/plugin-contract-v2.md)
- [M2 implementation evidence and deferred acceptance](docs/verification/2026-10-18/m2-implementation.md)
- [Separate production API/frontend composition](docs/architecture/production-runtime.md)
- [Plugin setup, credential rotation, updates and recovery runbook](docs/architecture/plugin-operations.md)
- [Shared model budget and temporary GWDG tariff](docs/architecture/model-budget.md)
- [Plugin contract and prototype boundaries](docs/architecture/plugins-and-prototype.md)
- [Technical basis](docs/architecture/technical-basis.md)
- [Security and model evaluation](docs/architecture/security-and-models.md)
- [LLM router credentials and provider configuration](docs/architecture/llm-router-credentials.md)
- [Model registry, user choice and fallback policies](docs/architecture/model-provider-configuration.md)
- [Verified message times](docs/architecture/chat-message-time.md)
- [GWDG SAIA and custom model connections](docs/architecture/gwdg-saia.md)
- [Knowledge MCP and authenticated document delivery](docs/architecture/knowledge-mcp.md)
- [Content adapter contract, MediaWiki/BlueSpice and HTML fallback](docs/architecture/content-adapters.md)
- [Coolify self-hosting, restricted synthetic MediaWiki and migration status](deploy/coolify/README.md)
- [Production SSO and anny authorization boundary](docs/architecture/anny-identity-and-authorization.md)
- [Booking cancellation and confirmation](docs/architecture/anny-cancellation.md)
- [Room snapshot provenance](docs/evaluation/anny-room-snapshot.md)
- [Evaluation plan](docs/evaluation/benchmark-v1.md)
- [Local prototype and public-demo verification](docs/verification/2026-10-16/verification.md)

## License

Copyright (C) 2026 Fabian Schmieder. This project is licensed under [GPL-3.0-only](LICENSE); see [NOTICE](NOTICE). Third-party dependencies retain their own licenses. This repository does not represent an operational HsH service or an institutional endorsement.
