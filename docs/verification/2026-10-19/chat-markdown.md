# Chat Markdown and source fidelity

Date: 2026-10-19. Integration baseline: `ce20795c60898057d14bf1094d3a5c42fdca7219`.
Scope: technical Markdown rendering and clipboard/source handling. Physical-device
and participant acceptance remain M8-A7; this does not accept all M2/M7.

`react-markdown` 10.1.0 and `remark-gfm` 4.0.1 render message bodies as React
elements. No raw-HTML plugin, image loading, embedded content, syntax-highlighter
network request or arbitrary HTML insertion is introduced. URL transformation
accepts only absolute HTTP(S) links without credentials or literal control/space
characters; links open with `noopener noreferrer`. Other link schemes and
relative/protocol-relative links render without navigation. Tables scroll within
a keyboard-focusable region rather than widening the chat.

The per-message native popover offers message/result content, exact Markdown
source, and a read-only source dialog. Source copying writes the original message
string as clipboard plain text; it does not serialize rendered DOM, tool arguments,
identity/session metadata or hidden retrieved context. The existing result-content
copy path retains its explicit projection. The source dialog supports normal
selection and its own copy action, including mobile-sized controls.

The composer and wire history preserve user source indentation and trailing
spaces instead of trimming them. The 4,000-character UI limit matches the wire
contract. Paste length accounts for the current selection; an oversized paste
does not silently discard characters or replace the existing draft. Blank-only
messages remain unsent. Model instructions now permit concise Markdown while
retaining source-citation, access and action-confirmation boundaries.

Static rendering countercases cover scripts, HTML images, Markdown images,
iframes, JavaScript URLs and credential-bearing URLs alongside positive GFM
formatting. Source tests cover four-space code indentation, hard-break spaces,
CRLF and trailing newlines. History tests verify source through the actual wire
schema and rolling-budget helper. Focused tests, required CI and deployed browser
observations are separate evidence; browser emulation does not qualify M8.
