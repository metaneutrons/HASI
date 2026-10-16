# Local prototype verification

Date: 2026-10-16. The evidence concerns the synthetic local prototype only.

## Automated checks

- Node.js 24.21.0 LTS: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
  `pnpm test` and `pnpm test:coverage` passed.
- 27 tests across six files passed. Coverage: 86.55% lines, 79.90% statements,
  81.50% functions, 70.52% branches. Thresholds remain 75/75/75/65.
- Frozen-lockfile install and `pnpm peers check` passed.
- Backend integration tests also passed under Node.js 26.11.1 during development.
- `pnpm preview` builds and runs the optimized web UI with the local mock
  identity/core/plugin/provider processes. Launcher shutdown was checked:
  ports 3001 and 4100–4102 were released without stopping unrelated services.

The tests exercise actual loopback HTTP, signed MCP invocations, mock anny
requests, confirmation ownership/argument checks, repeat confirmation, expired
proposals and outcome-unknown handling. A compatible replacement plugin is
activated against the same running registry; changed permissions and stale
update candidates are rejected. Pinned OpenAPI checks do not substitute for
testing the real HsH anny tenant.

## Browser checks

The in-app Chromium browser was used with explicit responsive viewport sizes.
Light and dark themes, persona login/logout, authorized room visibility, search
empty/reset states, room selection, availability, preparation, confirmation,
own bookings, administrator access, plugin toggle and update checking were
exercised. A complete synthetic booking also succeeded in the Node 24 optimized
preview.

Admin layouts were checked at 320, 375, 390, 768 and 1280 CSS pixels; measured
document scroll width matched viewport width. The user flow was visually
checked at 375 and 1280 pixels, including a 375-pixel form with 16-pixel inputs
and 44-pixel control heights. Selecting a room moves focus to the booking panel.
The empty reservation illustration no longer precedes room results on phones.

- [Mobile user view, light](mobile-light.jpg)
- [Mobile confirmed test booking](mobile-confirmed.jpg)
- [Mobile administration, dark](admin-mobile-dark.jpg)
- [Desktop user view, dark](desktop-dark.jpg)

Native iPhone/Safari and Android/Chrome, virtual keyboard, VoiceOver/TalkBack,
200% text enlargement, constrained-network performance and real SSO are not
qualified by these browser checks. They remain release acceptance work.

## Scope limits

No live HsH/anny identity, booking or notification was used. Intranet, Service-IT
knowledge retrieval and model integration remain unimplemented MVP work.
Proposals, sessions and registry state are in memory; no restart recovery or
multi-instance guarantee is established. Plugin artifact provenance and
third-party sandboxing remain production prerequisites.


## Chat and administration mobile follow-up (2026-10-16)

This later check covers the chat-first UI, after the initial prototype checks
above. It does not replace the earlier architectural scope notes with a
production-readiness claim.

- Responsive Chromium checks: 320×568, 375×667, 390×844, 393×852, 430×932,
  440×956, 568×320, 844×390, 768×1024 and 1280×800 CSS pixels. Chat,
  administration and bookings had no document horizontal overflow; tool cards,
  booking cards and administrative badges were checked for internal overflow.
- Exercised both themes, room search, availability, proposal, explicit synthetic
  booking confirmation, booking list, nine chat sessions, long chat names,
  rename, delete cancellation, long unbroken messages, account switching,
  student access denial, plugin disable/re-enable and update checking.
- Fixed navigation disappearing on short displays, clipped chat actions,
  undersized chat controls and notice dismissal, overflowing effect badges,
  and an almost invisible transcript in landscape. At 568×320 the compact
  transcript is 98px high; the composer ends at y=262, where the 58px navigation
  starts. At 844×390 the transcript remains 226px high.
- Chat height now follows VisualViewport events, with keyboard detection,
  zoom compensation and a compact layout below 260px of visible height.
  Five geometry tests cover keyboard, zoom, panning, unsupported APIs and
  rotation. They do not establish real iOS keyboard behavior.
- `pnpm lint`, `pnpm test` (96 tests in 16 files), the public-demo production
  web build and `pnpm typecheck` passed. The optimized build was also checked
  at 390×844 and 568×320.
- Actual Safari in an iPhone Air / iOS 26.4 simulator rendered the login page
  correctly. Native automation could navigate the Safari chrome, but pointer
  operations within the simulator failed (`noWindowsAvailable`) and webpage
  controls were absent from the accessible tree. Consequently the authenticated
  chat/admin workflows, software keyboard, zoom and browser-bar transitions
  have **not** been verified in iOS Safari. Physical-device acceptance remains
  open; responsive Chromium tests must not be described as iPhone tests.

Only synthetic data and explicit offline chat mode were used in these workflows.
No model credentials or provider configuration changed.
