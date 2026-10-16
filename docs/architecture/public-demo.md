# Public demonstration on Vercel

Date: 2026-10-16. Repository: `metaneutrons/HASI`, public, GPL-3.0-only.
Demonstration domain: `hasi.metaneutrons.cc`.

## Two distinct execution modes

The local reference prototype runs the core, signed MCP plugin, actual anny
HTTP client and contract mock as separate processes. Its permissions and
confirmation boundaries are enforced in the backend.

The public Vercel deployment builds the same UI with
`NEXT_PUBLIC_HASI_PUBLIC_DEMO=1`. Its API transport is replaced by a browser-only
simulation. It does not proxy to localhost or connect to real HsH, anny, SSO,
knowledge or model services. No integration credential is configured in Vercel.
This demonstrates interactions and appearance; it does not deploy the backend
or prove that real integration permissions work.

The main interface is a conversation. Room search, availability, own bookings,
proposals and confirmations render inline as tool result cards. A bounded
German dialogue parser fills explicit date/time/duration/capacity slots across
turns; it is labelled as a demo without a language model. It never executes a
booking based on prose confirmation. Knowledge questions receive an explicit
unavailable-source response instead of invented institutional advice or citations.

Demo accounts, proposals, bookings and the plugin switch are stored only in
the visitor's namespaced localStorage. Administrator selection is intentionally
available to everyone and affects that browser's simulation. It grants no
access to an institutional or shared administration system. Client-side
validation is convenience, not an authentication or authorization boundary.
Clearing site data resets the demonstration. Storage is bounded; blocked
localStorage falls back to nonpersistent in-memory state. Multi-tab changes
have no transactional or durable-booking guarantee.

Model selection, knowledge answers and source connectors remain unimplemented
MVP work. Plugin updates are not performed in the browser; the demo says this
explicitly. Independent MCP updates are verified by local integration tests.

## Deployment contract

- Vercel project `hasi`, team `metaneutrons`, root directory `apps/web`.
- Node.js 24.x; version-pinned pnpm 12.11.2 installation and build commands
  reside in `apps/web/vercel.json`.
- Set the public-demo flag to `1` in Preview and Production before building.
  Changing a `NEXT_PUBLIC_` value requires a rebuild.
- Local Vercel metadata, environment files and private research are ignored by
  Git. `.vercelignore` also excludes research/documents and test/build artifacts
  from CLI deployment uploads.
- DNS is a DNS-only CNAME to the project target returned by Vercel. Preserve
  other records in the zone. TLS is managed by Vercel.
- The site advertises `noindex` and disallows crawlers in `robots.txt` because
  its campus information and bookings are synthetic.

Rollback uses a previously verified Vercel deployment; no external booking or
database state needs migration for this browser-only mode. Future real backend
hosting and identity integration require a separate deployment design.
