# Bounded optimized admin UI latency observation

Date: 2026-10-19. Component candidate:
`24057ee1a1d238c6b06615bf5c78d7d46aa2566a` (PR #118). This is partial evidence
against the 200 ms local UI target, not full-app or M2/M7 acceptance.

A separate loopback in-memory fixture bundles the actual managed installation,
configuration and schema-field components with React/React DOM 19.3.1,
esbuild 0.28.2, production mode, tree shaking and minification. No provider,
database, installer, plugin process or production service is used. The actual
Chrome-family in-app browser was driven through its supported UI automation.

A native capture listener starts the clock; a target-specific expected DOM
change and two animation frames end it. Text input also requires the linked
React dirty marker, checkbox measurement requires its captured prior state and
new marker, and save feedback requires that exact disabled button's spinner
and busy text. Two animation frames offer a rendering opportunity, not a
physical-display guarantee. This method excludes automation round-trip time.
The synthetic draft response is delayed 120 ms to keep busy feedback observable;
the measured endpoint is visible busy feedback, not network completion.

| Final instrument / interaction | View | Observed elapsed |
| --- | --- | ---: |
| Open configuration | 390 px / light | 57.1 ms; separate run 51.0 ms |
| Change function checkbox + dirty marker | 390 px / light | 54.1 ms |
| One native key + field/dirty marker | 390 px / light | 18.4 ms |
| Save draft → actual busy feedback | 390 px / light | 47.5 ms |
| Open configuration | 320 px / dark | 57.3 ms |
| Immediate controlled DOM probe | 390 / 320 px | 60.5 / 56.6 ms |
| Deliberately delayed 250 ms probe | 390 / 320 px | 308.3 / 308.6 ms; both rejected |

At 320 px the document width was exactly 320 px. API-based field filling emitted
`input` without the instrument's required native `beforeinput`; those two setup
operations were correctly labeled INVALID and excluded from latency claims.
The earlier instrument incorrectly sampled checkbox dirty state after React's
click handling and also treated checkbox input as text input. That produced
INVALID measurements, not a product failure. Root corrected the capture point
and input type filter before the final measurements above. The final instrument
hash and bundle hash below identify the corrected version.

Source SHA-256 identities:

- Managed panel: `c22c0e527928c7532ffb738819b6646aea6c0be72c95aeabc97bbad39ea842b7`.
- Configuration panel: `33ecbc70bebf537c8f1006848c7f05bd64913aa4de63a6fae9a3179f31a23d08`.
- Schema fields: `93e01ae80c4fcffa271d4e6ac57791dd90d8251a4e20a6fbe2313587b117f4e9`.
- Corrected private instrument: `372c8e06a79c1b042942289a14ef7934b58fefcce2869f502e8112237c9ca5fb`.
- Optimized JS bundle: `cae47881a09818a1613306d42bb723245146d577ef178f5a5b5ed8e69baa5fea`.

This small component sample does not qualify chat, all controls, repeated input,
200% text, all viewport widths, actual devices or full production topology. The
private fixture remains an ad-hoc instrument, not a portable committed browser
runner. The full-app 200 ms gate stays open. The test tab was closed, viewport
reset, and owned server stopped; no persistent data was written.
