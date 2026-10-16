# HASI

Hochschule Hannover assistant: a mobile-first TypeScript prototype with a shared
light/dark design system for users and administrators, mock identity, and an
independently running anny plugin. This is an incomplete implementation of the
agreed MVP, not a production service.

**Public demo:** [hasi.metaneutrons.cc](https://hasi.metaneutrons.cc)
uses a browser-only simulation. All accounts are selectable test personas;
bookings and administrator changes stay in that browser. No real SSO, anny,
knowledge search or model service is connected. The local reference below
exercises the separate core/plugin/HTTP-client architecture.

## Run locally

Requires Node.js 24 LTS or 26 and pnpm 12.11.2. From this directory:

```sh
git clone https://github.com/metaneutrons/HASI.git
cd HASI
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:3001>. Choose a student, employee or administrator test
account. Search rooms, select a room, check availability, prepare a booking and
confirm the exact proposal. View the result under **Buchungen**. The
administrator can enable/disable the integration and check/activate compatible
plugin releases under **Verwaltung**. Theme selection offers Light, Dark and
System.

For an optimized web preview, use `pnpm preview`. This builds the application
first and runs the same mock backend with Next.js in production build mode;
it does not enable real SSO or live integration credentials.

The launcher creates ephemeral signing keys and service tokens automatically.
It starts the web UI on port 3001, core API on 4100, MCP plugin on 4101 and anny
mock on 4102, all on loopback. An occupied port stops startup; existing services
are not stopped. `HASI_WEB_PORT=3002 pnpm dev` changes the UI port and allowed
origin together. Stop the launcher with Ctrl-C.

All identities, rooms, access grants and bookings are synthetic. State is held
in memory and resets on restart. No HsH credentials or real anny token is needed.
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

To run only the public browser demo locally:

```sh
NEXT_PUBLIC_HASI_PUBLIC_DEMO=1 pnpm --filter @hasi/web build
pnpm --filter @hasi/web start
```

Use a free port if the full-stack prototype is already running. See
[public demo architecture](docs/architecture/public-demo.md) for its limits
and Vercel configuration.

## Packages and boundaries

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js UI, user and administrator surfaces |
| `apps/api` | Server-owned identity, authorization, registry, exact proposal confirmation |
| `packages/plugin-sdk` | Versioned HASI manifest, MCP transport, signed actor capabilities |
| `apps/anny-plugin` | Separately running room tools and anny customer/resource checks |
| `packages/anny-client` | Actual anny HTTP paths, query context and request/response contracts |
| `apps/anny-mock` | Synthetic external API for the same HTTP client |

The core has no runtime dependency on the anny plugin implementation. Plugins
advertise a manifest and MCP tools; the host controls identity and permissions.
Reads and preparations may be model-facing, writes require a separate explicit
confirmation. An approved compatible plugin version can be activated without a
core rebuild. Artifact distribution, publisher verification and operating-system
isolation for third-party plugins remain production work.

## Remaining MVP work

The mandatory MVP still includes permission-aware knowledge search with source
citations across both `intranet.hs-hannover.de` and `service.it.hs-hannover.de`,
plus anny. Neither knowledge source nor an LLM/model selector is connected in
this prototype. Real SSO, authoritative customer linking/rights, persistent
state, reconciliation, cancellation and real-device mobile qualification remain
open. Microsoft 365 Bookings is deferred.

- [Plugin contract, prototype boundaries and qualification criteria](docs/architecture/plugins-and-prototype.md)
- [Technical basis](docs/architecture/technical-basis.md)
- [MVP delivery plan](docs/plans/hasi-mvp.md)
- [Prompt injection defenses and model evaluation](docs/architecture/security-and-models.md)
- [First model comparison and dataset plan](docs/evaluation/benchmark-v1.md)
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
