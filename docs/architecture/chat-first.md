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
the host executes them through the existing API transport and renders tool cards.
In local reference mode that transport reaches the core/MCP/plugin/anny mock;
in public-demo mode it reaches the browser simulation. No execution tool is
exposed to the model. Exact proposals require the host confirmation button.

`chat-demo.ts` remains a deterministic, bounded German parser available only
through an explicit offline selection. There is no silent offline/provider
fallback on a Groq error. Knowledge retrieval is still absent; general model
answers must not be represented as verified institutional guidance or citations.

The transcript currently lasts for the mounted chat view. Leaving the route or
reloading starts a fresh conversation; confirmed demo bookings persist according
to the selected execution mode. Persistent, identity-scoped conversation storage
is separate MVP work.

## Production continuation

Move production tool orchestration and conversation storage into the application
API, retaining the provider interface and explicit model profiles. The current
client loop is limited to the prototype's synthetic data. Models propose calls
to registered tools; the core retains identity, authorization and execution policy. Neither a model
nor plugin-supplied prose can create or bypass confirmation. Tool cards use
host-owned, typed renderers rather than arbitrary plugin HTML or scripts.

IT/intranet search will use the same transcript, returning citations and only
content authorized for the current user. Model selection and evaluations must
compare both conversational quality and correct tool use. The browser demo is
not evidence that retrieval, model isolation or production prompt-injection
defences are implemented.
