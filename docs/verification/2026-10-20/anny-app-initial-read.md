# Reviewed Anny App initial read

Date: 2026-10-20. Baseline: `69b9b90a20a4c048e7ab549e3eb76a0c78b1796b`.
Partial M2/P2-A1 repair under consolidated plan V7
(`abd76038387b39c7342385473a5c56c6766c5afb`).

## Defect and boundary

The view previously adopted the initial interval but did not call its read tool.
An authored-controller test executing the actual template reproduced zero calls
instead of the required initial `anny.view_resources` read. Both original tests
failed before the repair and pass afterward.

The host always sends display arguments, even for an undated view. Each mounted
view starts one fresh typed app-only read after the first valid host input.
Duplicate input does not start another initial read. No cached resource body or
availability claim enters the view from chat history. The host still validates
output against the approved tool schema and applies authenticated current rights.
Errors, rejected calls and invalid response envelopes remove previous catalogue
results and expose Refresh plus the native chat fallback. A successful empty
catalogue remains distinct from loading or unavailable data.

The generated HTML/digest is rebuilt from the pinned MCP Apps SDK 2.0.3, with
its existing SDK license and immutable operator-review boundary. Public Apps
remain disabled. This is the reviewed local feasibility view, not admission of
unreviewed third-party UI code or a general sandbox acceptance claim.

## Local behavioral and API checks

Five template-controller tests and six actual signed API/plugin/mock tests pass.
The controller tests cover initial display, undated/invalid inputs, duplicate
input, retry, and removing old results on denied or malformed refresh. The API
tests separately cover approved resource identity, app-only visibility, actor
resource claims, paging/filtering, dates, undeclared tools and write denial.
Web TypeScript/lint and the production Next.js build pass. The complete pinned
Node 24 Linux/arm64 Docker build/export/unpack also passes, producing local image
config `sha256:14d798e425a97f041e81d287698b933eaa3c1ee4a9b49f2ddbac240473c4b6ec`.
The generated reviewed HTML is 443,574 bytes with SHA-256
`f370ebc6f9f271c7c0929afc4904a0d9dd153fcfcbee8fd85017bd361293f070`.

The fake SDK/DOM controller harness does not itself establish a browser sandbox
or real server authorization. Independent read-only source review found no
concrete initial-read regression. Full integration and delivery results belong
to the PR, with exact source identities.

## Actual local browser journey and P2-A1 measurements

A fresh Node 26.11.1 TestIdP/isolated PostgreSQL runtime used
`pnpm exec tsx scripts/dev.ts --test-idp --plugin-apps`, after the backend build.
No model credentials were inherited. Explicit Dialog-Demo searched for a 1J
workplace on 21 October 10:00–16:00. Opening the optional view performed one
resource GET and exactly one `anny.view_resources` call, showing six of 43
current authorized catalogue resources without a Refresh click. The requested
interval remained 10:00–16:00 Europe/Berlin. Native chat results retain their
separate availability authority; the App expressly states it does not check
availability.

CDP Network request/response timestamps from the actual tab record these single
local observations (response headers received, not DOM paint or percentiles):

| Action | Typed catalogue reads | HTTP response latency | Result |
| --- | ---: | ---: | --- |
| Initial open | 1 | 9.034 ms | 43 resources, page 1/8 |
| Reopen | 1 | 8.868 ms | Fresh first page |
| Select workplace kind | 1 | 13.868 ms | 37 resources, page 1/7 |
| Next page | 1 | 7.619 ms | Page 2/7 |
| Search Amrum | 1 | 9.414 ms | Two workplaces, page 1/1 |

Initial resource-GET request to catalogue-response headers took 89.145 ms on
the first open and 78.119 ms on reopen. These include the bridge/startup gap but
exclude click-to-request and final paint. The automated reopen click through
visible-status wait took 3,173 ms, including automation/transport/wait overhead;
it is not a measured application UI reaction or proof of the 200 ms gate.
Every catalogue request retained the original interval. Filtering and paging
made zero `/api/chat` generation requests, zero provider requests and therefore
zero additional input/output model tokens. This is a no-inference synthetic
journey, not a live-model comparison, cached-token or provider-billing saving.
Routine protected workspace reads are not counted as model generations.

During the first observation, native availability lease expiry caused protected
conversation reconciliation and unmounted the optional view. Reopening made a
fresh read. This record does not qualify uninterrupted view/filter state across
that reconciliation; joined M2 journey checks remain open.

At simulated 390 by 844 and 320 by 844, document width equals viewport width.
The embedded document is respectively 330 and 260 pixels wide with identical
scroll widths; visible Refresh is 44 pixels high. Closing the view removes its
iframe and leaves native room cards visible. The 390 px dark screenshot was
visually inspected. Temporary viewport overrides were cleared, the owned tab
closed, and the supervised runtime stopped successfully. This is local Chromium
simulation, not physical-device, native assistive-technology or M8 acceptance.

## Remaining scope

This repairs and measures the bounded initial/filter/page journey. Full P2/P3/P4/
P6 acceptance still requires the retained native history/access/fallback and
joined administration/account/reauthentication/recovery/mobile/UI checks. The
unreviewed-App no-go remains unchanged. M2/M6/M7 remain open; real institutional
and device qualification stays in M8. No paid providers or live tenant writes
were used.
