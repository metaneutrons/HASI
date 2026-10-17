# Chat event times

Date: 2026-10-17. Implemented for the prototype.

New user, assistant and tool events receive stable UUIDs and UTC ISO timestamps
from the server. The timestamp means **server receipt**, not the time a human
started typing, a source's publication time or proof that a tool actually ran.
The UI displays the date and time in Europe/Berlin. Tool-result receipt times
describe when results entered the conversation; availability must still be
checked again before proposing a booking.

## Trust and persistence

The browser continues to hold chat history in its account-scoped local storage.
It requests timestamps only for newly created events, in bounded batches at
`POST /api/chat/timestamps`. The route requires an authenticated demo session,
same-origin JSON and a separate WAF bucket per workspace/account. It does not
spend the inference bucket or invoke a model. No additional full-chat server
archive is introduced.

Each time receipt is an HMAC over the event ID, role, content, tool call fields,
timestamp and server-resolved workspace/account scope. The signing key is
domain-separated from the existing HASI demo secret. Receipts remain verifiable
across server restarts and deployments with that secret and scope; another
account/workspace or changed content does not verify. Provider keys are not used.
Changing the demo secret invalidates prior receipts without discarding chats.
Local development uses a process-local key, so its receipts become unknown
after restarting the web server.

Model responses are stamped server-side after generation. Host UI status text
and client-carried tool results receive server receipt times; a receipt does not
authenticate their contents or grant action authority. Timestamping is not a
tamper-proof conversation audit: clients can omit/reorder history, and a newly
submitted event can receive a new current receipt. It cannot acquire a valid
backdated receipt. Exact action authorization remains in the booking backend.

Legacy messages have no receipt. Loading a chat never backfills their times.
Failed time requests leave events unknown rather than using the browser clock.
Status-text coalescing invalidates old receipts and creates a separate combined
history event; individual visible status messages keep their own receipt times.

## Model context

Before inference, the server verifies receipts against the complete message
contents and current authenticated scope. Only verified times enter a
server-owned timeline; all other entries are explicitly null/unknown. Neither
receipt signatures nor credentials are sent to providers. The same timeline
is used for Groq, GWDG and custom profiles.

For each verified user event, the router calculates Berlin calendar anchors
for today, tomorrow and the day after tomorrow, using calendar days across DST
and year boundaries. Relative expressions refer to that event's date. An old
relative reference with unknown time requires clarification. The current
Berlin server clock remains available separately. These instructions improve
temporal grounding but do not guarantee model reasoning; proposals still show
an absolute interval and require explicit confirmation.

## New chats

Every fresh chat starts with `groq-oss-120b`, including the replacement after
deleting the final chat. Existing chats retain their selected model. GWDG and
other configured profiles remain manually selectable, with no automatic
cross-provider fallback.
