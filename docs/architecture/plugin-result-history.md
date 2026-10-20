# Protected generic plugin result history

Status: local implementation and bounded synthetic browser verification,
2026-10-20. M2/P3/P4/P6 remain unaccepted as complete qualification groups.
The joined fixture exposed generic-result omission/redaction and an intermediate
history/render loop. The new result path passes its bounded browser journey;
see [evidence and remaining gates](../verification/2026-10-20/plugin-result-authority.md).

## Authority and data flow

A browser-carried `_hasi` envelope is not proof. The server must invoke a current,
authorized read tool, validate the response and bind an immutable result context
to its authenticated owner, scope, conversation, signed assistant tool call,
arguments, plugin/tool identity, current authority and data classification.
Store that context with a distinct host signature and bounded retention in the
shared PostgreSQL-backed chat store. A context UUID is a reference, never a grant.
The current record expires after 30 days. Raw structure, depth, nodes, byte size
and serialized result length are checked before canonical serialization; getters
and `toJSON` hooks are rejected. Result cards remain plain, safely rendered data.

The protected chat read endpoint accepts the conversation, host-signed assistant
message and selected call ID. Resolve the hashed tool name from the authenticated
registry; no client-selected origin, credential reference or execute tool is
accepted. Validate the signed call/current authority and recheck authority around
the existing API invocation. Only the actual core response may create a context;
never expose an endpoint that signs a supplied result. Generic prepare/execute
continues through the separate immutable-proposal/confirmation/recovery boundary.
Core also enforces `requiredEffect: read` against refreshed tool state before
dispatch, so the read route cannot silently become a preparation during an update.

On subsequent model calls and workspace save/load, resolve context references
under the current authenticated owner/conversation and authority. Verify stored
signatures, expiry, plugin/model tool names, call ID and arguments. Ignore the
browser's result body. Rebuild the bounded result and its display card from the
verified record. Bind derived assistant answers to the result-context IDs in the
host evidence, so losing any dependency also excludes the derived answer.
Never promote tool text or metadata to application instructions.

Current aggregate history authority conservatively fences plugin lifecycle,
configuration, actor and personal-account revisions. It is not a signed receipt
for a browser result. Missing authority, storage or proof denies reuse. Source
revocation freshness still needs its institutional contract in M8. A retained
result is a historical observation, not evidence of current availability or an
execution confirmation; keep the fresh-read requirement in model projection.
Complete outgoing context remains subject to the deployment classification,
profile/fallback eligibility and shared budget policies.

This pre-release evidence extension deliberately has no legacy proof verifier.
Previously issued assistant proofs may be excluded and require a new query.
The PostgreSQL data and owner/session/budget identities are not reset. Older
application images do not understand new result references; immutable rollback
and forward recovery with this history format need their M7 operational exercise.

## Qualification required

- Authentic result flows from the API through the protected next model step and
  survives save/reload as a reconstructed card; the deterministic fixture records
  actual bounded reference data, not merely a second static completion.
- Forged or altered bodies, IDs, signatures, call IDs/arguments, wrong owner,
  conversation or scope, expired records, source/config/account withdrawal and
  unavailable storage/authority do not disclose retained output to user/model.
- The read endpoint cannot prepare/execute a business action or select arbitrary
  plugin destinations, credentials or source classifications.
- Concurrent saves and newer local replies reconcile without accepting forged
  cards, undoing rights withdrawal or aborting an unrelated action.
- Re-run the joined consent/renewal/task-return/revocation/action journeys and
  preserve native Anny, knowledge, model-switch and budget regressions.

Standalone storage tests, a signed digest, a fixture response or a green build
alone do not qualify this complete boundary. The implementation PR and current
milestone issue must record actual results and omissions before acceptance.
