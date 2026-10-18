# Chat-first interaction

Status: prototype correction, 2026-10-16.

HASI is a conversational university assistant. The primary route and navigation
entry are **Chat**. Room booking is one capability within the conversation,
alongside future permission-aware IT/intranet knowledge and additional plugins.
A room catalogue must not become the product's main information architecture.

The empty conversation offers task examples and a persistent message composer.
User turns and assistant responses form a transcript. Read tool results render
as inline cards; room/time selection prepares a proposal in the same transcript.
The exact room and interval are shown again in a confirmation card. Only its
explicit confirmation action calls the execution endpoint. Later dialogue
turns invalidate earlier actionable results/proposals; historic cards remain
visible. Booking lists are available both as a chat tool and a secondary page.
The administrative surface remains separate.

## Prototype boundary

The chat now supports real GroqCloud inference through the server-side
`/api/chat` endpoint and interchangeable approved profiles. Only the server
resolves credentials. Typed anny read/prepare calls are returned to the host;
the host sends them through the core API, which invokes the signed MCP plugin,
AnnyClient and synthetic HTTP service. Local development runs these components
as separate processes. Vercel co-locates their Node.js entry points and keeps
the same HTTP boundaries. The model receives no execution tool. Exact proposals
require the host confirmation button.

`chat-demo.ts` provides the bounded German parser for explicit offline mode and
for retaining online room constraints. Unambiguous standalone office preferences
and own-booking list requests use the same typed read bridge in online mode;
compound requests still use the selected model. This is host orchestration, not
a silent offline/provider fallback on a model error. Synthetic knowledge search
is available through the MCP knowledge service; its examples must never be
represented as verified institutional guidance.

The prototype supports up to 20 separate chats per test account in the browser.
Each chat owns its transcript, bounded model history, selected profile, draft,
room-search context, availability cache and current proposal. Switching chats
does not unmount their runtimes: replies finish in their originating conversation,
and another chat can run independently. Changing accounts or leaving the route
unmounts the runtimes and aborts pending model requests.

A versioned, size-limited browser store restores chats across navigation and
reload in both local and public-demo modes. Chats can be renamed or deleted;
deleting a chat does not cancel a booking. In-flight chats cannot be deleted. A
reload never resumes requests or executes actions automatically; interrupted
requests are marked. Restored availability cards are checked again before
preparing a proposal, and confirmation remains an explicit action bound to that
proposal. Chat histories remain local browser data. In the Vercel demo,
server-issued workspace cookies isolate public selectable personas, while
Neon Postgres stores synthetic sessions, proposals, plugin settings, replay
claims and bookings. Workspace cookies expire after seven days; a later visit
receives a new workspace with synthetic defaults. Local `pnpm dev` keeps backend
state in memory. Neither mode supplies institutional identity or protected
conversation storage.

## Production continuation

For institutional production, retain the provider interface and explicit model
profiles while adding real identity, source authorization and approved service
connections. The current server-backed demo uses synthetic identities and data.
Models propose calls to registered tools; the core retains identity,
authorization and execution policy. Neither a model nor plugin-supplied prose
can create or bypass confirmation. Tool cards use host-owned, typed renderers
rather than arbitrary plugin HTML or scripts.

IT/intranet search will use the same transcript, returning citations and only
content authorized for the current user. Real SSO, anny tenant/account linking,
full API coverage, third-party artifact isolation and live booking/cancellation
qualification and reconciliation remain open. The synthetic demo supports owned
future-booking cancellation through separate preparation and confirmation. Model selection and evaluations must compare both
conversational quality and correct tool use. The demo is not evidence that
institutional retrieval, real permissions or production prompt-injection
defences are implemented.
