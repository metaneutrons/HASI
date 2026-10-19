# Server-backed demo parity

Date: 2026-10-16. This requirement supersedes the browser-only demo execution mode.
Implementation: [PR #12](https://github.com/metaneutrons/HASI/pull/12).
[Qualification and publication evidence](../verification/2026-10-16/verification.md)
records the exact verified revisions and deployment; criteria remain below.

**Runtime update (2026-10-19):** The Vercel/Neon deployment described in the
original design has been retired. The public demo now runs on Hetzner under
Coolify with private PostgreSQL 18.6. CI-qualified source builds, exact-revision
deployment, retained state and rollback are accepted in
[#79](https://github.com/metaneutrons/HASI/issues/79). Earlier Vercel
checks remain historical evidence for their exact revisions, not current-host
qualification. See the [self-host cutover](../verification/2026-10-18/selfhost-cutover.md)
and [database cutover](../verification/2026-10-18/local-postgres-cutover.md).

## Outcome and boundaries

The deployed web UI uses the same HASI API, plugin registry, signed MCP transport,
anny plugin and AnnyClient as the reference application. Only the identity source
and external anny HTTP service use synthetic fixtures. Groq remains server-side.
There is no client-side booking, proposal or administration simulator or fallback.
Conversation history and theme preferences continue to use the common frontend
storage implementation in both deployment modes.

The demo uses an isolated server-issued workspace per browser; selectable personas
share that workspace's synthetic resource calendar but cannot access another
visitor's state. Fixture administrator rights apply only inside that workspace.
This isolation is a demo identity/tenant configuration, never institutional SSO.

## Design

- PostgreSQL JSON records with opaque revisions and atomic compare-and-set store
  sessions, proposals, plugin state, replay claims and the external API mock state.
  Local tests can use the same interface with an in-memory adapter.
- Opaque HttpOnly sessions are stored by token hash, expire and can be revoked.
  A signed workspace cookie binds the selected fixture identity to its test data.
- Core proposal confirmation atomically claims pending state before invoking MCP.
  Repeated confirmation never repeats an external write. Unknown outcomes stay
  unknown and cannot authorize a retry; stale execution claims become unknown.
- MCP invocations keep Ed25519 signatures, argument/version/actor binding and
  durable one-use invocation IDs. Service credentials stay server-side.
- The HTTP anny mock atomically checks conflicts across all customers in the
  workspace, commits UUID booking/order records and serves current availability.
- The current public demo runs under Coolify on the Hetzner host. HASI and the
  demo wiki use separate Compose resources; PostgreSQL 18.6 is on a private
  container network. The Vercel deployment composition is historical. #79
  records source-built main updates at their exact SHA, preserved durable state
  and budget records, and rollback qualification for automatic deployment.
  External plugin hosting remains operator-controlled; a rebuilt HASI image is
  not independent plugin distribution.
- The Neon database and Vercel project have been deleted. The self-hosted
  PostgreSQL database preserves the prior application state and shared budget.
  The host has daily encrypted backups and an operator-held Mac copy, but restore
  from an encrypted artifact and ongoing off-host replication/monitoring remain
  unqualified. No caller controls integration origins or secret names.
- Existing browser simulation bookings/settings are not imported as trusted state.
  Old local chat transcripts may display previous synthetic results; authoritative
  actions always revalidate through the server.

## Acceptance criteria

- P1: The browser always uses same-origin HTTP APIs; deployed responses demonstrate
  the API → signed MCP → AnnyClient → synthetic HTTP service chain.
- P2: Independent runtime instances resolve the same session, proposals, booking
  results and plugin settings from PostgreSQL; restart does not lose a booking.
- P3: Concurrent confirmations produce one external booking; overlapping bookings
  across personas conflict atomically. Expired/altered/foreign confirmations fail.
- P4: Anonymous requests and direct model execution are denied; logout revokes the
  session. One workspace's administrator cannot affect another workspace.
- P5: MCP replay across instances is denied. Integration tokens, database URLs and
  signing material never reach browser output, model context or stored state.
- P6: UI chat, booking and admin workflows, mobile layout and Groq remain usable;
  docs describe the actual execution path. All relevant tests, lint, typecheck,
  production build and required CI pass before merge.
- P7: The current Coolify production deployment on hasi.metaneutrons.cc shows
  the server-backed behavior at the exact intended source SHA. #79 qualifies the
  source build, readiness and rollback path; rollback restores a compatible prior
  image/state. The synthetic store remains separate and no real institutional API
  is configured without its own approval. Historical Vercel evidence alone does
  not satisfy current-host qualification.

No claim is made that every anny API operation, real SSO, institutional source
rights or institutional production rollout is implemented by this change.
Implementation PR and dated verification evidence will link back to these
criteria. The current synthetic Service-IT portal/catalog in progress is demo
content, not an HsH source inventory or M3 institutional acceptance. Technical
M3/M7 may qualify with reviewed synthetic fixtures; actual identity, source
rights, Anny tenant conformance and protected-data approvals are reserved for
final M8 #80. Under Plan V4, M7 retains automated/browser/simulator UX and
backup/restore/off-host operations qualification. Actual-device, native assistive
technology and participant acceptance are M8-A7.
