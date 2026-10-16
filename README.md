# HASI

Hochschule Hannover assistant: a chat-first, mobile-first TypeScript prototype with a shared
light/dark design system for users and administrators, mock identity, and an
independently running anny and knowledge MCP plug-ins. This is an incomplete implementation of the
agreed MVP, not a production service.

**Public demo:** [hasi.metaneutrons.cc](https://hasi.metaneutrons.cc)
is the configured domain for the Vercel demonstration. Its server-backed mode
uses the same core API, signed MCP plugin, AnnyClient and synthetic HTTP service
as the local reference. Vercel co-locates their Node.js entry points; Neon
Postgres stores isolated demo sessions, proposals, registry state and synthetic
bookings. The shared server runtime is live on the public domain;
[verification](docs/verification/2026-10-16/verification.md) records its scope.
GPT-OSS 120B and 20B plus Qwen3.8 27B (Preview) can be selected in chat; an
explicit offline dialogue mode is also available. Messages and selected tool
results are sent to GroqCloud. Use test data only. Student, employee and
administrator personas are intentionally selectable by every visitor inside
their own signed demo workspace. They do not establish institutional identity
or permissions. Workspace cookies expire after seven days; a later visit gets
a new workspace with synthetic defaults. Chat history remains in browser
storage. The room catalog is an authorized read-only HsH anny snapshot; availability and bookings are simulated. Knowledge documents are entirely fictional. No live anny tenant, real SSO or institutional knowledge source is connected.

## Run locally

Requires Node.js 24 LTS or 26 and pnpm 12.11.2. From this directory:

```sh
git clone https://github.com/metaneutrons/HASI.git
cd HASI
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:3001>. Choose a student, employee or administrator test
account. Start in **Chat**: describe a task, for example “Ich brauche morgen um
14 Uhr einen Raum für vier Personen für eine Stunde.” HASI asks for missing
details and embeds room results, available times and a booking proposal in the
conversation. Select a time and confirm the exact proposal on its card. View
the result in the chat or under **Buchungen**. **Neuer Chat** opens a separate
conversation. Switch, rename or delete saved chats in the chat list (drawer on
mobile), grouped under the collapsible Chat navigation on desktop. Drafts, profiles and contexts persist per test account in this browser;
ongoing replies finish in their original chat. The
administrator can enable/disable the integration and check/activate compatible
plugin releases under **Verwaltung**. Theme selection offers Light, Dark and
System. Without a local Groq credential, explicitly select **Dialog-Demo · ohne
Modell** to use the bounded German parser. To use Groq locally, set
`GROQ_API_KEY` in the server process environment or `apps/web/.env.local`;
Next.js loads that file from the web application's directory. Never commit it.
IT/Intranet questions search 60 synthetic documents through the knowledge MCP. Source cards open the authenticated demo reader, which repeats document access checks. These fictional procedures are not institutional advice. Try “Wie prüfe ich in der Service-IT-Demo den WLAN-Zugang Morgenstern-Lab?”
See [chat-first interaction](docs/architecture/chat-first.md).

For an optimized local preview, use `pnpm preview`. This builds the application
first and runs the separate core, plugin, HTTP mock and Next.js processes in
production build mode. The local launcher keeps demo data in memory and does
not enable real SSO or live integration credentials.

The launcher creates ephemeral signing keys and service tokens automatically.
It starts the web UI on port 3001, core API on 4100, anny MCP plug-in on 4101, anny mock on 4102 and knowledge MCP on 4103, all on loopback. An occupied port stops startup; existing services
are not stopped. `HASI_WEB_PORT=3002 pnpm dev` changes the UI port and allowed
origin together. Stop the launcher with Ctrl-C.

Identity and access grants, availability and bookings are synthetic. Room names and available catalog metadata come from the 2026-10-16 HsH anny snapshot; unknown seat counts remain unknown. The demo selects the first linked service as a simulation policy, not as real booking authorization. State is held
in memory and resets on restart. The Vercel server demo has separate scoped
Postgres state. No HsH credentials or real anny token is needed.
The included launcher connects only to the local anny mock and sends no real
bookings or notifications.

## Verify

```sh
pnpm research:anny
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
```

Build before lint/tests/type checks after a clean install: workspace imports
resolve package declaration files from `dist`. Integration tests use real
loopback HTTP and MCP calls. They cover user isolation, signed capabilities,
confirmation/replay boundaries and independent plugin updates. Client tests
also check fixtures against the pinned official anny OpenAPI specification.
The explicit research command fetches those third-party specifications and
verifies their SHA-256 pins; they are not redistributed in this repository.

To run the server-backed demo locally, configure these values in
`apps/web/.env.local`, using a local PostgreSQL database and a newly generated
32-byte base64url `HASI_DEMO_SECRET`:

```dotenv
NEXT_PUBLIC_HASI_PUBLIC_DEMO=1
HASI_DEMO_MODE=1
HASI_DEMO_ORIGIN=http://127.0.0.1:3001
DATABASE_URL=
HASI_DEMO_SECRET=
GROQ_API_KEY=
```

Then run `pnpm --filter @hasi/web dev`. This one-process mode uses the same
server-backed demo runtime with PostgreSQL. It is separate from `pnpm dev`,
which continues to launch the local multi-process, in-memory reference stack.
See [public demo architecture](docs/architecture/public-demo.md) for Vercel
configuration, data boundaries and current qualification status.

## Packages and boundaries

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js UI, user and administrator surfaces |
| `apps/api` | Server-owned identity, authorization, registry, exact proposal confirmation |
| `packages/plugin-sdk` | Versioned HASI manifest, MCP transport, signed actor capabilities |
| `apps/knowledge-plugin` | Permission-filtered synthetic knowledge search and document retrieval over MCP |
| `fixtures` | Curated demo corpora and room snapshot, excluding private source captures |
| `apps/anny-plugin` | Separately running room tools and anny customer/resource checks |
| `packages/anny-client` | Actual anny HTTP paths, query context and request/response contracts |
| `apps/anny-mock` | Synthetic external API for the same HTTP client |
| `packages/demo-runtime` | Server-backed demo workspaces and co-located HTTP/MCP handlers |
| `packages/state` | Memory and PostgreSQL JSON stores with atomic updates |

The core has no runtime dependency on the anny plugin implementation. Plugins
advertise a manifest and MCP tools; the host controls identity and permissions.
Reads and preparations may be model-facing, writes require a separate explicit
confirmation. An approved compatible plugin version can be activated without a
core rebuild. Artifact distribution, publisher verification and operating-system
isolation for third-party plugins remain production work.

## Remaining MVP work

The mandatory MVP still includes permission-aware knowledge search with source
citations across both `intranet.hs-hannover.de` and `service.it.hs-hannover.de`,
plus anny. Synthetic knowledge retrieval is implemented; real source adapters, production model-profile policy/approval and
institutional integration remain incomplete. Real SSO, authoritative anny
tenant/account linking and permission mapping, full API coverage, production
third-party artifact isolation, cancellation, reconciliation and real-device
mobile qualification remain open. The Vercel demo's durable synthetic state
does not provide institutional authorization or booking reconciliation.
Microsoft 365 Bookings is deferred.

- [Plugin contract, prototype boundaries and qualification criteria](docs/architecture/plugins-and-prototype.md)
- [Technical basis](docs/architecture/technical-basis.md)
- [MVP delivery plan](docs/plans/hasi-mvp.md)
- [Prompt injection defenses and model evaluation](docs/architecture/security-and-models.md)
- [LLM router credentials and provider configuration](docs/architecture/llm-router-credentials.md)
- [First model comparison and dataset plan](docs/evaluation/benchmark-v1.md)
- [Synthetic Service-IT/Intranet corpus and test questions](docs/evaluation/synthetic-knowledge-seed.md) — entirely fictional fixtures and draft evaluation cases
- [Knowledge MCP and authenticated document delivery](docs/architecture/knowledge-mcp.md)
- [HsH room snapshot provenance](docs/evaluation/anny-room-snapshot.md)
- [Service-IT source research](docs/research/service-it.md)
- [anny API research and pinned specifications](docs/research/anny-api.md)
- [HsH identity evidence and open attribute contract](docs/research/hsh-identity.md)

Authenticated source captures and derived corpora remain local and are ignored
by Git. Research captures do not establish a production authorization policy.

## License

Copyright (C) 2026 Fabian Schmieder. Licensed under **GPL-3.0-only**;
see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain
their own licenses. This repository does not represent an operational HsH
service or an institutional endorsement.
