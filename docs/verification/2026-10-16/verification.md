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


## Server-backed demo parity (2026-10-16)

This supersedes the earlier browser-only and in-memory demo boundaries above.
Acceptance authority: [server demo parity P1–P7](../../plans/server-demo-parity.md).

- P1/P2/P4: Six integration cases (three memory, three PostgreSQL) exercise real
  TCP HTTP and signed MCP across two runtime instances, a third cold runtime,
  isolated cookie jars and durable fixture identities/settings. Anonymous and
  direct execution calls fail; logout revokes the session. Another workspace
  cannot read/confirm the proposal or change the first workspace's integration.
- P3: Concurrent exact confirmation produces one booking; changed/foreign
  confirmation fails. Separate mock tests race overlapping bookings across
  customers and verify one succeeds and one conflicts, without partial writes.
- P5: Shared-store replay rejection is tested across plugin instances. Stored
  registry settings are signed and checked against the approved manifest/scope.
  Credentials are injected only into server-owned transports.
- Local PostgreSQL 18.6: `TEST_DATABASE_URL=... pnpm test:coverage` passed 113
  tests in 19 files. Coverage: 90.65% lines, 84.51% statements, 91.11% functions,
  75.70% branches. Lint, typecheck, peer checks, actionlint and the Next.js
  production build passed. Subsequent boundary tests and CI are recorded below.
- P6: In-app Chromium at 390×844 completed offline chat search → availability →
  proposal → explicit confirmation → booking list → reload. The new booking
  remained present. At 320×568 admin disable → reload remained disabled;
  re-enable and real manifest update check succeeded. Admin card and page
  widths matched the viewport; desktop 1280×800 had no horizontal overflow.
  Native iPhone/Safari limitations described above remain unchanged.
- Dedicated Neon `hasi-demo`, free_v3, Frankfurt, was connected to Preview and
  Production. Database credentials were provisioned by the integration, never
  pulled for inspection. Separate server-only demo secrets were provisioned.

Six additional web-boundary tests passed: anonymous chat, missing Vercel mode,
storage failure with generic errors, authenticated delegation, canonical Host
adaptation and rejection of an unapproved Host. Final local suite: 119 tests in
20 files; 90.64% lines, 84.50% statements, 91.11% functions, 75.81% branches.
Both local-reference and server-demo web builds passed; the reference HTTP
proxy was verified on port 3018. Production dependency audit is clean.

Preview/production runtime qualification and required CI remain pending at this
local verification checkpoint. No real HsH or anny data were used.


### Published server runtime qualification

- Implementation merged as [PR #12](https://github.com/metaneutrons/HASI/pull/12),
  main revision `22180ec4bddace1c0cc9c9342b0d893eff02bb8e`. Required CI passed
  under Node 24 and 26 in [run 38911403261](https://github.com/metaneutrons/HASI/actions/runs/38911403261);
  post-merge CI also passed in [run 38911680959](https://github.com/metaneutrons/HASI/actions/runs/38911680959).
- Preview `hasi-cowt581iv-metaneutrons.vercel.app` passed 18 API checks through
  actual deployed core/MCP/mock routes, including one booking, repeated exact
  confirmation without another booking, admin disable/read-back/re-enable and
  update checking. Anonymous chat was denied; authenticated real Groq GPT-OSS
  120B inference returned successfully. The platform preview requires Vercel
  authentication, so these remote preview checks used the authorized CLI.
- Production deployment `dpl_CTRLngv2FeEAunMzcZEbpJ7CQAaT`,
  `hasi-gl6pdik5v-metaneutrons.vercel.app`, is READY and serves
  `https://hasi.metaneutrons.cc`. Deployment metadata confirms `fra1`; the project
  function default was also explicitly corrected to `fra1`. The earlier CLI
  deployment used the project's previous `iad1` default despite the nested
  web configuration. No real HsH data were sent in these checks.
- At 390×844 on the public domain, GPT-OSS 120B performed real room search and
  availability tools. A proposal prepared before the deployment/region change
  was explicitly confirmed after it, demonstrating that the signed workspace,
  session and proposal survived the replacement server runtime.
- Live booking list retained the new UUID booking after reload. Admin disable →
  reload retained the disabled setting; re-enable and actual manifest update
  checking succeeded. Page/card scroll widths matched 390px and 320px viewports.
  Dark 568×320 chat retained its composer and navigation with no horizontal
  overflow; the prototype notice is hidden in the compact layout.

## Knowledge MCP, room snapshot and integrated chat navigation

Local qualification on 2026-10-16 covers the next demo delivery:

- 60 entirely fictional knowledge documents (30 Service IT / 30 Intranet), 80 draft evaluation cases, stable IDs and citations; no protected original bodies or private URLs in the public fixture. Corpus checks include invalid/unauthorized references, original-source URL and duplicate-citation counter-probes.
- Signed `knowledge.search` / `knowledge.get_document` MCP through the registry. Search filters by signed test audience before ranking or exposing metadata. Source cards resolve strict IDs to the authenticated demo document reader; unknown and denied reads have the same generic 404. Logout denies subsequent reads.
- Actual loopback HTTP/MCP tests use two independent runtime instances and a third cold instance with both legacy and imported catalogs. The 30-room catalog snapshot and 9 services are curated from the user-authorized read-only API import. Unknown capacity stays null; availability, access grants and writes remain synthetic.
- Local PostgreSQL 18.6 tests: 135 passed across 22 files; coverage 91.77% lines, 85.70% statements, 92.09% functions and 76.68% branches. This includes the approved-pin backup and final fixture curation; CI requalifies the final candidate.
- Lint, TypeScript and the public-demo production build passed. Production dependency audit found no known vulnerabilities. Independent code review found no high/medium issues in the knowledge boundary or signed-state migration. Publication review found operational booking statements in four room descriptions; all room descriptions were removed before publication.
- Browser checks: desktop 1280px uses the single left navigation with collapsible chats; 390px uses the chat drawer. Knowledge search displays source cards; the 390px reader displays fictional text; a student cannot open the admin-only document, and the admin test account can. At 320px the two plug-in cards and controls remain within the viewport. Imported-room search → proposal → explicit simulated booking completed at 390px.

These are responsive-browser checks, not native iPhone/Safari keyboard qualification. Full model evaluation against the 80 draft cases, real HsH source adapters/SSO rights, original-source URL resolution and institutional model-provider approval remain open. Deployment IDs and required CI results belong in the implementation pull request evidence; local work is not represented as already published.
