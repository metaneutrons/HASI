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
