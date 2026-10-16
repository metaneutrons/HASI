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

`chat-demo.ts` is a deterministic, bounded German parser for demonstration, not
an LLM or general assistant. It carries explicitly stated search fields across
follow-up turns and asks for missing booking details. Unsupported questions
receive an honest capability response. There are no fabricated IT answers,
source citations, search results or completed actions. The UI calls the existing
API transport; in local reference mode it reaches the core/MCP/plugin/anny mock,
and in public-demo mode it reaches the isolated browser simulation.

The transcript currently lasts for the mounted chat view. Leaving the route or
reloading starts a fresh conversation; confirmed demo bookings persist according
to the selected execution mode. Persistent, identity-scoped conversation storage
is separate MVP work.

## Production continuation

Replace the demo dialogue interpreter with a server-side conversation endpoint
and interchangeable model adapters. Models propose calls to registered tools;
the core retains identity, authorization and execution policy. Neither a model
nor plugin-supplied prose can create or bypass confirmation. Tool cards use
host-owned, typed renderers rather than arbitrary plugin HTML or scripts.

IT/intranet search will use the same transcript, returning citations and only
content authorized for the current user. Model selection and evaluations must
compare both conversational quality and correct tool use. The browser demo is
not evidence that retrieval, model isolation or production prompt-injection
defences are implemented.
