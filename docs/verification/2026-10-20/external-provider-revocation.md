# External provider revocation across joined replicas

Date: 2026-10-20. Related to M2 #49; M2/M6/M7 remain open.

The joined development fixture now has a terminal-only external revocation
control for the administrator's reference account. It changes only the synthetic
provider inspection state, waits for correlated acknowledgements from both API
replicas and does not invoke host disconnect/revoke. Ordinary authenticated
account-status reconciliation detects that external transition. Another persona
is unaffected; no fault control is exposed through HTTP, MCP or model input.

A deterministic concurrent-status reproducer found an actual race: two services
could inspect the same revoked grant, but the second status request failed with
`account_changed` after the first reconciled it. Reconciliation now accepts only
that exact already-completed provider transition, preserving one authority
increment and one history event. Newer consent, disconnect or a pending consent
flow still conflicts. Account tests exercise simultaneous revoked and expired
inspections and reject stale inspections after newer completed/pending consent.
The IPC counterprobe withholds the second valid acknowledgement and proves that
the control does not complete early or accept a wrong-persona acknowledgement.
Sixteen focused account/process tests passed. Root types, affected typed lint
and a separate bounded source review passed; the reviewer did not repeat tests.

## Actual local browser journey

Node 24.21.0 / pnpm 12.11.2 ran the actual local web app, two API replicas,
PostgreSQL 18.6, TestIdP, deterministic HTTPS model and independently packaged
reference plugin with SQLite. The fixture used an isolated HOME and no real
provider credentials. The normal administrator UI configured and activated
read-only reference version 1.0.0 and completed personal synthetic consent.
Two actual chat reads produced visible result cards and dependent answers;
a browser reload retained both. The viewport was 1280x720.

With an unsent draft present, terminal `revoke-reference` acknowledged both API
replicas. Connected services' normal status refresh showed revoked access and
external-revocation history. A read-only PostgreSQL observation confirmed host
authority 1 to 2, provider revision 2, confirmed revocation and exactly history
`consent:1,external_revocation:2`. The disconnect action was not used.

Immediate chat return and full reload redacted both old result cards and both
dependent answers, retained both user prompts and preserved the draft. Sending
that draft returned the reconnect notice. Synthetic model calls increased 4 to 5;
prior-result, prior-answer and requests-with-prior-context observations stayed
2/2/2. Reference invocations stayed 2. Marks, SDK journal, source rows, proxy
executions and real-provider calls all stayed zero. These counters distinguish
history exclusion from merely hiding content in the browser.

The fixture exited successfully with owned processes stopped and caller database
retained. No institutional integration, live-provider response quality, billing,
foreign-persona browser journey, mobile/native assistive technology or complete
M2 acceptance is established. Managed pending-action update/disable/rollback
and the remaining technical UI matrix require separate qualification.

## Qualified application/test inputs

The browser exercised the uncommitted candidate over base
`eda6a129c5c49f65ae5920475a31ebc6d02c7dfe`. These SHA-256 identities make that
scope explicit; later integration/CI evidence belongs to the implementation PR.

| File | SHA-256 |
| --- | --- |
| `apps/api/src/plugin-accounts.ts` | `a9190f10ff5dab4306baaab7830b890286d95188fd181fd90ecb7f2512e1470b` |
| `scripts/serve-plugin-journey.ts` | `946270ddfd5c5f5faad5062da6c473a5c7c3dc57ab2e5e2f1b5b4219387831d9` |
| `tests/plugin-accounts.test.ts` | `35a0961e318fa52415458f21a8b701ceecaa0472ec87a7d251b0575c724b67c2` |
| `tests/plugin-journey-process.test.ts` | `a701f88421bb5d18f7c272f166f2cd8e3badc4328278716787ed9ce8b948f43a` |
