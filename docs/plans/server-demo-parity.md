# Server-backed demo parity

Date: 2026-10-16. This requirement supersedes the browser-only demo execution mode.
Implementation: [PR #12](https://github.com/metaneutrons/HASI/pull/12).
[Qualification and publication evidence](../verification/2026-10-16/verification.md)
records the exact verified revisions and deployment; criteria remain below.

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
- Vercel initially co-locates HTTP entry points in one deployment, while using
  independently versioned packages and actual MCP/REST requests between them.
  This is deployment composition, not alternate business logic. External plugin
  hosting remains an operator-controlled deployment option and existing local
  update tests cover independent plugin replacement.
- PostgreSQL is a dedicated Neon resource in Frankfurt, free_v3 plan. Preview and
  production use separate state namespaces and separately provisioned demo secrets.
  Preview self-requests retain deployment protection via the server-only Vercel
  automation credential. No caller controls integration origins or secret names.
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
- P7: A qualified preview and production deployment on hasi.metaneutrons.cc show
  the server-backed behavior. Rollback restores the prior deployment; the new
  synthetic store remains separate and no real institutional API is configured.

No claim is made that every anny API operation, real SSO, knowledge retrieval or
institutional production rollout is implemented by this change. Implementation
PR and dated verification evidence will link back to these criteria.
