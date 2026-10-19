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


## P2-A4 adoption disposition — 2026-10-19

The reviewed implementation approach for the technical MVP is **native host
results by default; no-go for automatic admission of unreviewed third-party
executable Apps**. The public Apps flag remains off and its reviewed-code
allowlist remains empty. The bundled, immutable Anny view remains a local
opt-in feasibility experiment. Connecting a plugin or approving its tool
contract cannot enable executable browser code. This formalizes the scoped
engineering recommendation above; it does not accept all P2 criteria.

| Dimension | Finding and decision consequence |
| --- | --- |
| Security | The source-bound bridge, typed read permissions, code hash and sandbox/CSP constrain the reviewed experiment. They do not generally prohibit hostile scripted self-navigation. That unresolved boundary is sufficient for the no-go; unreviewed Apps are not admitted while awaiting more tests. |
| Mobile | Five simulated widths and theme propagation were observed for the reviewed view. This is partial feasibility evidence, with text enlargement and complete interaction/recovery cases unrun. No real-device acceptance is claimed. |
| Accessibility | Complete keyboard, focus and automated accessibility checks were not qualified by the feasibility run. This provides no basis for general adoption; native host interaction remains the product path and keeps its separate P4/P6 requirements. |
| Performance | The named filter/page observations made one typed tool call each and zero additional model calls. They do not establish an initial-result latency distribution or provider token/cache/billing savings. The missing bounded P2-A1 initial-journey measurements remain open; a paid model is not required by that technical criterion. |
| Compatibility | The experiment used MCP client/core 2.3.1 and ext-apps 2.0.3 with an immutable packaged resource. Future SDK, mobile-app host and external-view compatibility is unqualified. |

The revised implementation uses host-owned native text, compact structured
results and authorized source references. Identity, current source/account
access and exact confirmation stay in server/host controls. The
[current native-history boundary](../2026-10-19/current-native-history.md)
rebuilds retained cards from current authorized records and fails closed after
revocation or unavailable authority. Historical rendering does not execute old
actions. Full native configuration/chat/reconnect/update/removal/history
journeys remain P3/P4/P6 work; this decision does not mark them passed.

Unrun or unsuccessful rejected-App cases stay documented for any later
reconsideration, rather than becoming an obligation to finish an unsafe
adoption path before retaining the no-go. Broader Apps admission requires a
separately reviewed isolation approach and the relevant security, mobile,
accessibility, performance and compatibility evidence. Real-device and native
assistive-technology acceptance remains M8-A7. This disposition changes neither
the plan criteria nor the approved data or write scope.
