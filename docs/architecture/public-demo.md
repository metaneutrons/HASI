# Public demonstration on Vercel

Date: 2026-10-16. Repository: `metaneutrons/HASI`, public, GPL-3.0-only.
Demonstration domain: `hasi.metaneutrons.cc`.

## Two distinct execution modes

The local reference prototype runs the core, signed MCP plugin, actual anny
HTTP client and contract mock as separate processes. Its permissions and
confirmation boundaries are enforced in the backend.

The public Vercel deployment builds the same UI with
`NEXT_PUBLIC_HASI_PUBLIC_DEMO=1`. Its anny/session/admin API transport remains a
browser-only simulation. The separate Next.js `/api/chat` endpoint uses AI SDK
Core and the Groq adapter with a server-resolved `GROQ_API_KEY` Vercel Secret.
The key is never sent to the browser or an integration plugin. This deployment
does not proxy to localhost or connect to real HsH, anny, SSO or knowledge
services. It does not deploy the core/MCP reference stack or prove institutional
integration permissions.

The main interface is a conversation. Room search, availability, own bookings,
proposals and confirmations render inline as tool result cards. The default
profile is Groq GPT-OSS 120B, with GPT-OSS 20B selectable for comparison. Each
assistant response records the resolved profile. An explicit offline selection
retains the bounded German dialogue parser; provider errors never silently
switch to it or another provider. General model answers are available, while
IT/intranet source retrieval and source citations remain unavailable.

The server validates the complete wire message/tool sequence and executes one
inference step. The browser performs at most four such steps per user turn,
stopping once host-rendered availability, proposal or booking cards supply the
answer and next action. It runs only the four typed anny read/prepare tools through the existing
transport. Their data are synthetic and client-controlled in this mode. The
browser sends messages and bounded tool outputs to GroqCloud, as stated in the
UI. Client-side tool results/history are not authenticated institutional
evidence. No model-callable booking execution or cancellation tool exists.
Only the existing host-owned confirmation card calls the confirmation endpoint.
Prepared intervals must match a previously observed available interval.

Demo accounts, proposals, bookings and the plugin switch are stored only in
the visitor's namespaced localStorage. Administrator selection is intentionally
available to everyone and affects that browser's simulation. It grants no
access to an institutional or shared administration system. Client-side
validation is convenience, not an authentication or authorization boundary.
Clearing site data resets the demonstration. Storage is bounded; blocked
localStorage falls back to nonpersistent in-memory state. Multi-tab changes
have no transactional or durable-booking guarantee.

Institutional knowledge answers, source connectors and production model data
policy remain MVP work. Plugin updates are not performed in the browser; the demo says this
explicitly. Independent MCP updates are verified by local integration tests.

## Deployment contract

- Vercel project `hasi`, team `metaneutrons`, root directory `apps/web`.
- Node.js 24.x; version-pinned pnpm 12.11.2 installation and build commands
  reside in `apps/web/vercel.json`.
- Set the public-demo flag to `1` in Preview and Production before building.
  Changing a `NEXT_PUBLIC_` value requires a rebuild.
- Set `GROQ_API_KEY` as a server-side Vercel Secret in the required environments.
  GET `/api/chat` reports configuration presence and approved profiles only;
  a successful inference is a separate runtime check.
- `apps/web/vercel.json` pins functions to `fra1`. The chat handler permits a
  maximum 30-second invocation, with a 20-second provider timeout, no automatic
  retries, 1,536 output tokens, a 60,000-byte request body, 30,000 message-content
  characters and four validated tool calls per inference step.
- Vercel WAF rule `hasi-chat` allows 60 inference requests per 600-second fixed
  window. The SDK uses a server-owned shared key and a pinned callback host
  `hasi.metaneutrons.cc`; Preview checks use the same public project firewall
  without creating a deployment-protection bypass. Missing/failed limiter
  checks fail closed before inference. Local execution has no distributed WAF.
- The WAF counter is regional, not an atomic worldwide token or currency
  budget. Input/output and request caps bound prototype throughput; provider
  quotas remain separate. Durable per-user/day accounting and a hard monetary
  ceiling require further infrastructure before an institutional pilot.
- Provider HTTP 429 responses produce a distinct quota notice. Diagnostics log
  only host-owned failure categories and HTTP status codes, never provider error
  payloads, messages, headers, prompts or credentials.
- Local Vercel metadata, environment files and private research are ignored by
  Git. `.vercelignore` also excludes research/documents and test/build artifacts
  from CLI deployment uploads.
- DNS is a DNS-only CNAME to the project target returned by Vercel. Preserve
  other records in the zone. TLS is managed by Vercel.
- The site advertises `noindex` and disallows crawlers in `robots.txt` because
  its campus information and bookings are synthetic.

Rollback uses a previously verified Vercel deployment; no external booking or
database state needs migration for the simulated anny state. Future real backend
hosting and identity integration require a separate deployment design.
