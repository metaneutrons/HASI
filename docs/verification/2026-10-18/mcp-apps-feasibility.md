# MCP Apps feasibility decision record

Date: 2026-10-18. Engineering recommendation for P2 #70: **no-go for
unreviewed third-party Apps in the public demo or institutional production**.
The reviewed Anny read-only view remains an opt-in local experiment. This
recommendation is not acceptance of P2 or a waiver of its mobile/security gates.

## Boundary and revised approach

The iframe uses `allow-scripts` without same-origin privileges, immutable
resource SHA-256 verification, an independent operator code-review allowlist,
an injected CSP and a source-window-bound official MCP Apps bridge. Only
explicitly app-visible read tools are callable; execution, arbitrary host
messages, context updates and links are not granted. The public demo flag stays
off. Missing or denied resources retain native text/cards and source links.

Browser CSP and iframe sandboxing do not establish a general prohibition on
scripted self-navigation. A manifest cannot approve its own executable view.
Consequently these controls do not qualify hostile JavaScript. General Apps
adoption needs a separately reviewed isolation design and the negative/mobile
matrix; it must not be enabled by changing a manifest or an admin checkbox.
Continue the registry-driven tool integration using trusted native host
presentations. Optional reviewed views must never own confirmation or identity.

## Observed local journey

The in-app desktop Chromium browser ran the loopback Test-IdP stack with
`--plugin-apps`; the chat explicitly selected the model-free Dialog-Demo.
Anny MCP/client calls used the 43-resource snapshot and synthetic service.

1. A room request for 19 October 2026, 14:00–15:00, four people produced six
   native meeting-room results. The reviewed view displayed that same requested
   interval. Original checked results and additional unchecked catalog results
   have separate explanatory text.
2. Selecting **Arbeitsplatz** retrieved 37 authorized workplaces in pages of six.
   Moving to page 2 retained the requested interval and workplace filter.
3. Entering **1J** retrieved 27 matches and reset to page 1. CDP observed one
   POST `/api/tools/call`, HTTP 200, 11.262 ms request-to-response; there was
   no POST `/api/chat` in that measured interaction.
4. Moving to the next filtered page made one POST `/api/tools/call`, HTTP 200,
   11.170 ms request-to-response, and no POST `/api/chat`. Both calls used the
   app-only `anny.view_resources` contract. They generated zero additional
   model input/output tokens because no inference request was made.
5. Changing HASI to dark mode updated the view's `data-theme=dark` and computed
   background `rgb(16, 21, 29)`. Host/view DOM widths matched their scroll widths
   at 320, 375, 390, 768 and 1280 px; no horizontal overflow was observed.

These are single local observations, not latency percentiles, live provider
token savings, cache hits or invoice savings. The initial generation used no
model; an initial live-model latency/token comparison remains unqualified.
The browser screenshot is retained locally as
`.vercel/m2-mobile-plugin-view.jpg`; it is not a publicly distributed artifact.

The tested dependency versions are MCP client/core 2.3.1 and the official
`@modelcontextprotocol/ext-apps` 2.0.3. The generated resource is regenerated and
repinned on byte changes. Actual iPhone/Safari, Android/Chrome, VoiceOver,
TalkBack, virtual keyboards, 200% text, focus recovery, hostile navigation and
the complete cross-chat/instance negative matrix remain open qualification work.
