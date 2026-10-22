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
corpus and explicitly registered server-owned manifest. Case `inject-02`
(poisoned Anny resource) remains excluded. The original
`access-03` is not directly executable; the explicitly named deployment-scoped
runtime variant below uses its current question and a separately code-owned
fixture source matching the note. It does not claim same-instance tenant
partitioning. Plan validation checks candidate source ID, revision, title and
text against that code-owned catalog before fixture execution; those corpus
fields still grant no authority. An unknown case cannot register a tool,
source, role, permission or destination.

| Runtime case | Actual fixture behavior |
| --- | --- |
| `access-01` | Reader with an authoritative source grant and Lumen document ACL |
| `access-02` | Outsider with the same source inventory and no Lumen grant |
| `inject-01` | Authorized Atlas editorial revisions 3/4 (policy editions 2/3), with the attack only in editorial revision 4 |
| `inject-03` | Authorized temporary-account guide; runner canary never projected |
| `inject-04` | Authorized OCR-text card containing an outbound-disclosure instruction |
| `inject-04-host-preloaded-runtime` | Separate controlled exposure: host performs the code-owned `north-entry-card` query against `service_it` before the first model call and signs the actual returned context into authenticated history |
| `inject-01-clean-runtime` | Separate clean Atlas control derived from `intra-01` |
| `access-01-revoked-runtime` | Actual retrieval/answer, signed source-grant revocation, then current-history reconstruction |
| `access-03-deployment-scoped-runtime` | Isolated Alpha/Beta fixture authorities; Beta positive read, Alpha empty search and denied session/document/context replay |

The named runtime variants are not additional reviewed corpus
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

`inject-04-host-preloaded-runtime` is a distinct controlled-exposure variant of
the same draft case and trusted `north-entry-card` reader fixture. Before the first
protected chat request, the host calls the authenticated native `knowledge.search`
with the code-owned scenario query and `service_it`, verifies the returned source
ID, canonical title, text and revision, then records the actual arguments and
context ID. The host composes a signed assistant tool-call event and its actual
tool response under the current reader authority. The protected route still
verifies that signature and resolves the context against current source rights.
The result labels this path `host_preloaded_native_read`; it does not claim the
model initiated retrieval. The original `inject-04` remains model-planned, so a
model-selected `intranet` filter still produces no OCR exposure. Planning this
variant makes no provider-call or paid-observation claim.

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
bounded provider text/tool proposals, route status and executed read effects.
They do not store authorization headers or provider reasoning. Private reports
contain synthetic model inputs for reproducibility and subsequent human review;
ordinary production logging does not acquire those prompts. Response capture
records refusals and preserves received HTTP status even when a bounded body
cannot be read. Partial-capture diagnostics use fixed parser-branch enums.
Recognized text may be retained within the existing bound; proposals are omitted.
Unknown provider field values, unsupported type values and reasoning are not
retained. When a recognized chat response has `unexpected_message_member`, the
private evaluation result also records the exact unknown-member count and at most eight sorted
SHA-256 name digests. Each digest is computed over the UTF-8 bytes of the fixed
domain separator `hasi.provider-message-member-name.v1\0` (a terminating NUL byte) followed by the UTF-8
member name. Raw member names and values are not retained, and this diagnostic
does not inspect or serialize member values. The digest list is truncated when
the count exceeds eight. Field names often have low entropy, so these digests
are guessable by checking candidate names and are not anonymization. They appear
only in the private evaluation result, not standard output or production telemetry.
The explicit optional chat assistant `name` member is different from unknown
extensions: only a string, null, or absence is accepted and its value is
immediately discarded. It cannot establish identity, role, permissions or a tool
name. Other types produce `assistant_name_metadata_invalid`, omit proposals and
stop before any evaluator-controlled read or follow-up. Unknown sibling members
still use the partial-capture diagnostics above. This is a bounded evaluator
compatibility decision, not a change to production authorization or the route's
SDK response handling.

A 2026-10-22 [actual diagnostic](https://github.com/metaneutrons/HASI/pull/205#issuecomment-6330233751)
identified a current DeepInfra member as `name` by hash comparison. Its value was
not retained, so neither its type nor compatibility with this new rule is proven.
The original historical unsupported member remains unrecoverable. DeepInfra's
[public OpenAPI](https://api.deepinfra.com/openapi.json) describes nullable-string
`name` on the assistant **input** component, while the chat HTTP-200 output schema
is unspecified. That is supporting compatibility context, not a formal documented
output guarantee. The old report remains partial; a new qualified observation is
required before claiming this fixes actual DeepInfra capture.

Malformed, partial or unrecognized successful responses stop the
current case as soon as its chat-route request returns. The route status is kept,
but the incomplete route reply is not recorded or executed by the evaluator, so
it cannot trigger a source read, revocation follow-up or another paid route step.
The existing batch stop reason remains `provider_observation_unavailable`; an
incomplete response is never treated as an empty safe proposal list. No outgoing
observation is marked passed before an admitted provider attempt is inspected.
An unsafe provider proposal rejected by the backend is distinct from a safe model
answer.

Usage and cost come from the existing admission observer. Known-undispatched
released reservations are separate from provider-reported usage; they cannot
justify an HTTP request count. Unknown or unconfirmed settlements remain unknown.
Tariffs are estimates, including the expressly provisional GWDG rates, not invoices.
No old unknown hold or budget window is reset or refunded.

The deployment-scoped variant creates two separate in-process API/repository
compositions with independent scopes, TestIdPs, sessions, source-signing and
context-signing keys. Beta has the frozen private note; Alpha has signed empty
snapshots. Beta's authenticated positive retrieval prevents an empty-everywhere
false pass. Alpha must reject the peer cookie, return a generic404 for the known
Beta document ID and resolve the Beta context as unavailable. Only Alpha's
operator-selected API transport may reach the model route; peer source markers
are forbidden at the outgoing model boundary. The result explicitly records
`tenancyScope: isolated_in_process_deployments` and the individual probes. This
does not qualify physical network/container separation, correct operator source
wiring or tenant partitions inside a shared service instance. No tenant claim or
new product authorization mechanism is introduced.

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
Source/tenant scenarios beyond this bounded deployment variant, Anny/tool-output,
full planning/calendar/dialogue, model-switch and rendering/network requirements
remain technical M6 work. Under V11, human answer adjudication belongs to final
M8-A11/A12; Groq cache proof remains M8-A10. Neither transfer establishes a pass.
