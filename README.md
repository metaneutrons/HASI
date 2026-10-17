<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hasi-hero-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hasi-hero-light.svg">
    <img src="docs/assets/hasi-hero-light.svg" alt="hasi — Hochschule Hannover" width="1100">
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

## What works today

- **Chat and room workflows:** multiple saved conversations in a collapsible Chats list; new chats start with the operator default (Groq GPT-OSS 120B in the demo); server-issued UTC message times displayed in Europe/Berlin, with unknown legacy times preserved; room search, compact progressive results, availability, booking and cancellation proposals with separate explicit confirmation inside the conversation; responsive layouts with light, dark and system themes.
- **Room and workplace catalog:** 61 resources and all 9 services from an authorized, read-only HsH anny snapshot dated 2026-10-16. The demo offers 37 individual workplaces and six meeting rooms; 18 office containers provide context and cannot be booked as a whole. Person capacity is separate from bookable quantity. No lecture halls occur in this snapshot. Availability, access grants, bookings and cancellations remain synthetic. Office filters use the complete parent/desk hierarchy (eight offices with one recorded desk, ten shared offices); six standalone desks have no office classification. See [booking units](docs/architecture/anny-booking-units.md).
- **Knowledge demo:** 60 entirely fictional documents, split between Service IT and Intranet examples. Search applies synthetic audience access rules before returning content, and the authenticated demo reader checks access again. These documents are not HsH guidance.
- **Model registry:** versioned server configuration supports GroqCloud, GWDG SAIA, native OpenAI Responses/Chat, Anthropic Messages and multiple OpenAI-compatible endpoints. Operators choose the default, explicitly enable/limit user selection and define bounded fallback rules. Fallbacks are off in the bundled demo; eligible configured fallbacks pin the actual model for the tool turn and never replay business actions. Groq has live demo evidence; GWDG remains Experimental. Other adapters are mock-transport tested, not live-qualified. Use synthetic test data only.
- **Test identity:** visitors can select student, employee or administrator demo personas in an isolated workspace. They are fixtures, not real SSO, HsH identities or institutional permissions.

The [public demo](https://hasi.metaneutrons.cc) uses a server-backed runtime and isolated synthetic state. Chat transcripts and profile settings stay in browser storage; the server stores workspace sessions, proposals, integration settings and simulated bookings. There is no live anny tenant, institutional knowledge source or real SSO connection.

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

To use GroqCloud or GWDG SAIA locally, provide the corresponding server-side credential in `apps/web/.env.local` or the web server process environment. A profile without its own credential is unavailable; choose another configured profile or explicitly select **Dialog-Demo · ohne Modell**:

```dotenv
# apps/web/.env.local
GROQ_API_KEY=
GWDG_API_KEY=
```

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
CUSTOM_API_KEY=
CUSTOM_ENDPOINT=
CUSTOM_MODEL_ID=
```

Then run `pnpm --filter @hasi/web dev`. This PostgreSQL mode is separate from `pnpm dev`, which continues to run the multi-process in-memory stack. Do not commit `.env.local` or place secrets in client-visible variables. See [public demo architecture](docs/architecture/public-demo.md) for the runtime and data boundaries.

For an optimized local preview, run `pnpm preview`. It builds the application first and runs the separate local services in production build mode with in-memory demo data. It does not enable real SSO or live integration credentials.

## Verify changes

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm research:anny
pnpm test
pnpm test:coverage
```

Build first after a clean install: workspace declaration files are emitted to `dist` and are needed by linting, type checks and tests. Integration tests use loopback HTTP and MCP calls. `pnpm research:anny` fetches the third-party anny specifications, verifies their pinned SHA-256 values and materializes them for contract tests; the specifications are not redistributed here.

## Architecture and boundaries

| Area | Responsibility |
| --- | --- |
| `apps/web` | Next.js chat, room booking and administration UI |
| `apps/api` | Server-owned identity, authorization, plugin registry and proposal confirmation |
| `apps/anny-plugin`, `apps/knowledge-plugin` | Room tools and permission-filtered synthetic knowledge tools over MCP |
| `packages/plugin-sdk`, `packages/anny-client` | Versioned plugin contract, signed capabilities, and anny HTTP contracts |
| `packages/demo-runtime`, `packages/state` | Co-located server handlers and memory/PostgreSQL JSON stores |
| `fixtures` | Curated fictional knowledge corpus and read-only room catalog snapshot |

The host owns identity, permissions and state transitions. The model can search and prepare a proposal; only the user can confirm the exact proposal, and the current booking path writes to the synthetic service. Production third-party plugin isolation, source integrations and institutional authorization remain open work.

## Status

HASI is an incomplete MVP prototype, not an operational Hochschule Hannover service. Real SSO and account linking, institutional permission mapping, live availability and booking, real Intranet/Service-IT source adapters, cancellation and booking reconciliation, production provider approval, third-party plugin isolation, and native-device qualification remain outstanding. Responsive browser checks do not establish iPhone or Android qualification. The public demo's durable synthetic state does not provide institutional authorization or booking reconciliation.

Versioned GHCR images for `linux/amd64` and `linux/arm64` are built only through Release Please. The workflow and local Compose demo are implemented; no GHCR image has been published, and hosted native qualification is recorded separately in [D3](https://github.com/metaneutrons/HASI/issues/17). See the [container runtime and release boundaries](docs/architecture/container-runtime.md) before building or selecting a release image. Read-only mainline qualification uploads CI artifacts without creating a tag or release.

The roadmap additionally covers [public web search restricted to operator-approved URL scopes](docs/architecture/restricted-web-search.md), Moodle, Stud.IP, HISinOne (including exam registration and student records), SAP leave/time workflows, and a versioned knowledge base of examination regulations for every degree programme, including scanned PDFs, OCR and exact page citations. These integrations are planned, not implemented.

See the [MVP plan](docs/plans/hasi-mvp.md) and [server-demo parity criteria](docs/plans/server-demo-parity.md) for qualification scope.

## Project documents

- [Chat-first interaction](docs/architecture/chat-first.md)
- [Plugin contract and prototype boundaries](docs/architecture/plugins-and-prototype.md)
- [Technical basis](docs/architecture/technical-basis.md)
- [Security and model evaluation](docs/architecture/security-and-models.md)
- [LLM router credentials and provider configuration](docs/architecture/llm-router-credentials.md)
- [Model registry, user choice and fallback policies](docs/architecture/model-provider-configuration.md)
- [Verified message times](docs/architecture/chat-message-time.md)
- [GWDG SAIA and custom model connections](docs/architecture/gwdg-saia.md)
- [Knowledge MCP and authenticated document delivery](docs/architecture/knowledge-mcp.md)
- [Production SSO and anny authorization boundary](docs/architecture/anny-identity-and-authorization.md)
- [Booking cancellation and confirmation](docs/architecture/anny-cancellation.md)
- [Room snapshot provenance](docs/evaluation/anny-room-snapshot.md)
- [Evaluation plan](docs/evaluation/benchmark-v1.md)
- [Local prototype and public-demo verification](docs/verification/2026-10-16/verification.md)

## License

Copyright (C) 2026 Fabian Schmieder. This project is licensed under [GPL-3.0-only](LICENSE); see [NOTICE](NOTICE). Third-party dependencies retain their own licenses. This repository does not represent an operational HsH service or an institutional endorsement.
