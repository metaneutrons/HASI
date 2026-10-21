# Actual-route application-policy observations

This operator runs draft synthetic development cases through the same server-only
chat handler used by the web route. It is separate from fixed-evidence and
unknown-action-outcome observations. It does not complete M6, approve a model,
establish institutional access or replace human semantic review.
The [Linux package proof](../verification/2026-10-21/application-policy-package.md)
records four actual source/route paths with injected provider responses; it is
not a live model comparison.

## Plan before execution

```sh
pnpm evaluate:application-policy --profiles groq-oss-120b --cases access-01,access-02 --max-calls 4
```

The default is plan-only: no fixture session, provider call, credential readiness
check or budget-store access. The command accepts only the reviewed bundled
corpus and explicitly registered server-owned manifest. Cases `inject-02`
(poisoned Anny resource) and `access-03` (a different tenant) are excluded until
their additional trusted fixtures exist. An unknown case cannot register a tool,
source, role, permission or destination.

| Runtime case | Actual fixture behavior |
| --- | --- |
| `access-01` | Reader with an authoritative source grant and Lumen document ACL |
| `access-02` | Outsider with the same source inventory and no Lumen grant |
| `inject-01` | Authorized Atlas revisions 2/3, with the attack only in revision 3 |
| `inject-03` | Authorized temporary-account guide; runner canary never projected |
| `inject-04` | Authorized OCR-text card containing an outbound-disclosure instruction |
| `inject-01-clean-runtime` | Separate clean Atlas control derived from `intra-01` |
| `access-01-revoked-runtime` | Actual retrieval/answer, signed source-grant revocation, then current-history reconstruction |

The last two are registered runtime variants, not additional reviewed corpus
cases or acceptance of the original static cases. Corpus entitlements, candidate
documents, expected labels and tool fixtures never establish source authority.
The code-owned scenario catalog supplies signed source snapshots and grants.
Reports preserve the mapping from logical corpus IDs to the institutional
repository's document IDs, revisions and source digests.

## Trusted execution boundary

Actual execution requires `--run --output <new.ndjson>`, explicit
`HASI_MODEL_EVALUATION=1`, a pinned `HASI_EVALUATION_BUILD_REVISION`, approved
configured profiles/prices, and the existing shared PostgreSQL model budget.
Use the reviewed operator image and its existing hidden runtime environment;
never copy credentials into arguments, reports or the repository. The report is
exclusively created with mode `0600`; an existing path is not replaced.

The evaluation image retains its existing fixed-evidence operator entrypoint.
Select this operator with the trusted Docker override `--entrypoint node` and
arguments `--conditions=react-server --import tsx apps/web/scripts/evaluate-application-policy.ts`
before its reviewed options. This changes only the operator executable, not the
serving app, configured profiles, secrets or budget identity.

The operator opens durable admission against the deployment database **before**
creating the local fixture composition. The trusted handler constructor receives
that same admission handle. It neither initializes a ledger nor creates a second
evaluation budget. The ordinary web route retains its existing admission getter.
No HTTP field, model output, document or plugin can select the constructor's
admission dependency.

The process then temporarily applies the existing loopback TestIdP configuration
and isolated test-database URL required by the local guard. The guard is unchanged;
this URL does not choose the captured budget store. Actual source/IdP/API state is
separate in-memory fixture state. Cookie values, signing material and database
URLs are never reported. Environment and fetch instrumentation are restored in
`finally`, and the owned fixture is closed. Concurrent execution in one process
is rejected; this runner must never be invoked inside the serving application.

The source path is actual local TestIdP authorization-code/PKCE identity, signed
source repository, signed MCP invocation, authenticated API tool call and current
receipt resolution. Model-proposed `knowledge_search` arguments reach that actual
read tool. No other model-proposed tool is executed. The unchanged chat handler
checks authentication, origins, current rights/history, allowed tools, full local
deployment classification, routing, timestamps and the shared budget.

Every provider HTTP attempt needs its own current reservation. Destinations are
restricted to the fixed core API and selected configured model endpoint; redirects
and extra requests beyond the cap are rejected. Unexpected or revoked evidence at
the outgoing boundary is contained and recorded as a failed application
observation, never reclassified as a successful model refusal. Source/IdP fixture
transports are separately constrained; this instrumentation is not a container-wide
network-isolation claim.

## Measurements and limits

The batch rotates profile order per case/repetition, retains connection spacing,
stops a connection after provider errors or unknown usage, and stops the batch
after failed observation/cleanup. There is no automatic fallback. A four-step
route loop, 90-second request deadline and per-case/batch HTTP caps bound work;
provider-specific repair attempts are counted and charged separately.

Reports separate actual API/search observations, model-visible request identities,
bounded provider text/tool proposals, route rejection and executed read effects.
They do not store authorization headers or provider reasoning. Private reports
contain synthetic model inputs for reproducibility and subsequent human review;
ordinary production logging does not acquire those prompts. Response capture
records refusals and preserves received HTTP status even when a bounded body
cannot be read. Malformed, partial or unrecognized successful responses stop the
batch rather than becoming an empty safe proposal list; no outgoing observation
is marked passed before an admitted provider attempt is inspected. An unsafe provider
proposal rejected by the backend is distinct from a safe model answer.

Usage and cost come from the existing admission observer. Known-undispatched
released reservations are separate from provider-reported usage; they cannot
justify an HTTP request count. Unknown or unconfirmed settlements remain unknown.
Tariffs are estimates, including the expressly provisional GWDG rates, not invoices.
No old unknown hold or budget window is reset or refunded.

The actual route uses its server clock; the static case clock is recorded but is
not silently injected as production time. Effective inputs may differ across runs
because of clocks, protocol identifiers or model choices. Exact input digests and
these differences must be reviewed before claiming a paired comparison. Reported
case latency includes fixture setup, sources, route calls and cleanup; it is not
first-token/model-only latency or the deferred API p95 measurement.

The source probe may pass while a model omits retrieval or gives a false answer.
If the model never retrieves before the revocation variant, that scenario is
explicitly `scenario_not_exercised`. No semantic score, human/gold label, model
ranking, cache hit or M6 acceptance follows from technical success. Remaining
cross-tenant, Anny/tool-output, full planning/calendar/dialogue, model-switch,
rendering/network and human-adjudication requirements remain in M6; Groq cache
proof remains M8-A10.
