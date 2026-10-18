# M2 implementation and qualification ledger

Date: 2026-10-18. Source candidate: `fix/m2-plugin-foundation`, based on main
`7cd7674`; exact reviewed implementation/CI revisions are recorded in M2 #49.
This is a partial-delivery ledger, not acceptance of the complete milestone.

## Demonstrated locally

- OIDC loopback Test-IdP login completed through the actual browser redirect and
  callback; the UI identified the synthetic Test-IdP administrator. Reload and
  reauthentication retained the local conversation history. Mock persona login
  is unavailable on the OIDC path. Production construction requires a current
  authority resolver; tests cover role downgrade, denial, failure and timeout.
  The optimized build returned to `/admin` after a real Test-IdP round trip.
  Public account IDs derive from issuer and subject, independently of a mapped
  persona template ID; tests distinguish two subjects mapped to the same role.
- The optimized browser reproduced and then passed an immediate-composer-input
  → navigation → logout → Test-IdP reauthentication → chat-return regression,
  at 1280 px and 390 px. The exact unsent text survived. A persistent per-account
  root provider replaces per-route stores; passive snapshots cannot overwrite
  a newer synchronous draft. Store/session tests cover late snapshot persistence.
- Admin configuration saved revision 1 while active revision remained 0; a
  separate activation advanced the active revision. Per-tool disabling and
  reenabling were exercised in the actual UI. DOM measurements at 320, 375,
  390, 768 and 1280 px found no horizontal page/control overflow in that flow.
  This was the desktop in-app Chromium browser, not an actual phone.
- The v2 Anny claim contract was tested over real loopback MCP/HTTP with all
  43 bookable snapshot resources. The 32-entry initial claim limit failed the
  browser journey and was corrected to 256, retaining total actor byte/node
  bounds. Native room results again returned the requested 19 October 2026,
  14:00–15:00 interval for four people. At 390 px the same browser then
  prepared and explicitly confirmed a mock booking, displayed exactly one owned
  booking, prepared cancellation, and confirmed its authoritative cancelled
  status. Booking-overview page widths also matched 320/375/390/768/1280 px
  without horizontal overflow.
- The optional reviewed Anny App initialized in a sandboxed `about:srcdoc`
  iframe at 390 px. Initial six native meeting-room results were displayed;
  **Aktualisieren** retrieved all 43 authorized resources. CDP request events
  recorded exactly one POST `/api/tools/call`, HTTP 200, request-to-response
  25 ms, and zero POST `/api/chat` calls for that refresh. This is one local
  observation, not a latency percentile or provider/cache/billing saving.
- The completed filter/paging retest retained the requested interval, showed
  37 workplaces and then 27 `1J` workplace matches, with distinct pages.
  Each measured filter/page interaction made one typed read and zero chat
  inference requests (11.262/11.170 ms local HTTP observations). Host theme
  changes reached the view; host and iframe had no horizontal overflow at
  all five viewport widths. See [the feasibility decision](mcp-apps-feasibility.md)
  for the engineering no-go recommendation for unreviewed third-party Apps.
- An explicit admin connection check probes the active pinned manifest and MCP
  discovery without calling business tools. It reports configuration,
  reachability/contract, authentication evidence and unassessed user rights
  separately. HTTP 403 does not claim failed authentication. Unsaved drafts
  remain untouched; the real MCP integration and parser tests pass.
  The optimized Next build's actual UI confirmed all five statuses at 390 px,
  retained an unsaved per-tool restriction through the check, and had zero
  horizontal page/control overflow at 320/375/390/768/1280 px.
- Browser startup exposed a real generated-script error: string replacement
  interpreted `$` sequences in the minified SDK. Function replacement fixed
  it; extracted scripts pass `node --check`. The packaged pinned SDK notice
  is included. The resource's generated digest changes whenever its bytes do.
- Four HTTP lifecycle regressions pass: configuration activation between route
  check and invocation cannot execute old approval under new configuration;
  an endpoint swap invalidates pending proposals; removing a source prevents
  another replica from re-enabling it; changed projected account claims require
  a fresh proposal.
- PostgreSQL integration tests ran against a dedicated disposable local
  `postgres:17` container. Twenty simultaneous admission attempts through
  separate ledger instances admitted ten and rejected ten at a 100-micro-USD
  test ceiling. The application USD 1 policy was explicitly initialized against
  that test database; this is not deployment-database bootstrap evidence.
- Final local unit/integration checks with PostgreSQL passed on Node 24.21.0:
  528 tests in 56 files, coverage 79.31% statements / 74.47% branches / 88.08%
  functions / 85.96% lines in the existing gated service scope. Strict
  typecheck/lint, the production Next build and 48 release-policy tests passed.
  Production dependency audit reported no known vulnerabilities. Hosted CI and
  an exact reviewed deployment remain separate evidence gates.
  The same 528 tests also passed on Node 26.11.1; these are local runs, not
  hosted CI results. These checks include the final account-store lifetime
  and stale-snapshot draft correction.
- The live Groq cache probe now reserves every actual HTTP attempt, including
  plain controls, against an existing PostgreSQL ledger even in development.
  Tests cover denied admission, missing/invalid usage, transport uncertainty
  and concurrent probe-call bounds. No live provider experiment was run.
- Independent review found and fixed zero-input usage refunds and unbounded
  accumulation of prior-window unknown reservations. Invalid usage retains its
  hold; bounded late-reconciliation IDs and cumulative conservative archives
  prevent permanent admission exhaustion. Another review fixed seccomp
  admission, cleanup on staged trust revocation and late route-commit races;
  focused positive/negative regressions pass.
- The first hosted Node 24/26 and Vercel Preview builds failed because the
  prototype API bootstrap imported the Anny App digest without a workspace
  dependency. Local retained declaration files had hidden that defect. The
  bootstrap now accepts an explicit operator-reviewed digest; only the local
  launcher selects the bundled reviewed view. A clean local build after removing
  generated `dist` and `.next` directories passes. The follow-up hosted head
  must qualify independently; the failed head is not claimed as green.
- See [the separate Docker evidence](m2-container-driver.md): real Engine
  admission/inspection/reconciliation/cleanup was exercised, but the permitted
  base image had no running plugin health endpoint. No healthy application,
  external distribution or in-process denial qualification is claimed.
- [The independent reference process](reference-plugin.md) was connected,
  configured, invoked and explicitly confirmed once, then updated from 1.0.0 to
  1.0.1 while Core stayed running. Exact temporary source commits and local SDK
  fingerprint are recorded. This uses a local SDK build, not a self-contained
  distributed artifact; registry rollback was unavailable and was not simulated.

## Criterion status

The [consolidated plan](../../plans/consolidated-delivery.md) remains the
acceptance authority. “Implemented” below describes candidate code; it does not
close an issue or waive the remainder of its criterion.

| Criterion | Candidate evidence | Remaining acceptance work |
| --- | --- | --- |
| P1-A1 | v2 manifest/configuration/identity projection; installation and revision types | Institutional identity/tenant contracts; secret-custody rotation workflow |
| P1-A2 | Generic discovery/hash aliases, bounded schemas/results and host proposals | Mandatory cross-plugin provenance/pagination envelope qualification |
| P1-A3 | Documented journeys and live draft/activation test | Complete personal consent/renewal/revocation and interrupted-task UX review |
| P1-A4 | v1 regression/digest preservation; old pending approvals invalidated; optional Apps boundary | Independent distribution/compatibility inventory and operator approval |
| P2-A1 | Reviewed read-only Anny view; typed filter/paging, preserved interval and measured zero inference calls | Repeatable initial/live-model latency/token comparison |
| P2-A2 | Source-bound bridge, CSP/sandbox/hash/read visibility, independent UI allowlist | Browser negative cases across chats/instances; hostile self-navigation cannot be fully confined by this iframe design |
| P2-A3 | Host context and native fallback implemented | Keyboard/touch/200% text/focus/theme/lost-resource qualification on target platforms |
| P2-A4 | Public flag off; documented engineering no-go for unreviewed Apps, native path retained | Reviewed adoption decision and complete negative/device matrix |
| P3-A1 | Registry-derived tools; collision/schema/name/result tests | Integrated malicious/schema/model-switch matrix with trusted source classifications |
| P3-A2 | Anny/knowledge wrappers plus generic HTTP fixture; all 43 resources | Actual independent external artifact journey and institutional data contracts |
| P3-A3 | Subject/account/arguments/config/manifest/endpoint bindings; single claimant; stale/race tests | Generic authoritative reconciliation and complete consequence/account preview qualification |
| P3-A4 | Native cards/transcripts retained; optional view is lazy | Complete Apps-off/removal/history access regression in deployed topology |
| P4-A1 | Schema primitives/help, draft/save/activate, explicit read-only connection check and separate readiness evidence | Conditional/nested setup UX and complete field-level API remedies |
| P4-A2 | Signed durable CAS configuration/audit; logical secret status and operator revision | Complete secret abstraction binding/rotation with current custody versions |
| P4-A3 | Per-tool policy, disable and replica-safe catalogue removal | Personal disconnect/renewal/revocation and retained-data lifecycle |
| P4-A4 | Browser widths and draft/activation inspected | Full phone/keyboard/assistive-technology reconnect/update journey |
| P5-A1 | Approved remote catalogue, connection-time DNS/address/redirect policy | Reviewed plain-MCP adapter and deployment topology qualification |
| P5-A2 | Signed releases, digest pins and operator-local Docker driver | License/dependency inventory; healthy independent plugin and runtime denial proofs |
| P5-A3 | Durable staging/coordinator and exact binding checks | Operator route controller, UI change review and integrated migration preflight |
| P5-A4 | Retained previous release, trust checks and unknown-state reconciliation tests | Actual artifact/state recovery exercise, not only fake-driver tests |
| P5-A5 | Runtime matrix documented; no arbitrary Vercel process installation | Truly independent remote/artifact update without host rebuild |
| P6-A1 | Separate process/temp Git source, configure/read/confirm/update without Core restart | Self-contained external artifact and chat/update/rollback end to end |
| P6-A2 | Proposal/config/replica/account race tests, OIDC denial tests | Malicious UI, loss/reconciliation after mobile reauthentication and actual deployment |
| P6-A3 | Desktop browser viewport checks only | Actual iPhone/Safari + Android/Chrome, VoiceOver/TalkBack, keyboards/safe areas/200% text |
| P6-A4 | Developer contracts, budget notes, README and limited runtime runbook | Final criterion-linked immutable code/CI/deployment evidence and complete operator lifecycle runbook |
| BUD-A1 | Durable CAS reservations, attempt hooks, unknown holds, exhaustion/unavailable tests | Deployed bootstrap/live usage path, rate policy migration and provider-side quotas; GWDG price is explicitly estimated |
| WEB-A1 | Shared strict TS inheritance and type-aware strict ESLint; existing meaningful web tests | Final Node 24/26 CI; frontend coverage scope remains explicit, no blanket coverage/native UX claim |

M2 remains open. Test-IdP authorization replaces the need for institutional
credentials during implementation; it does not accept real HsH SSO or source
rights. Production API/worker separation, personal account lifecycle, independent
plugin deployment/recovery and actual-phone gates remain outstanding.
