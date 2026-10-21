# Fixed-evidence and observed-workflow provider observations

The separate [actual-route application-policy operator](application-policy-observations.md)
uses authenticated synthetic source fixtures and the web handler's current-context
path. It does not silently turn the fixed-evidence or unknown-outcome runners into
application-policy acceptance.

The operator command `pnpm evaluate:models` runs the existing HASI model router
on the bundled synthetic development corpus. It is separate from the offline
transport runner: provider usage and measured task latency are never labelled
synthetic measurements. This is a development comparison tool, not a completed
M6 comparison, gold dataset, human review or institutional approval.

## Plan before dispatch

From the repository root:

```sh
pnpm evaluate:models --profiles groq-oss-120b,gwdg-qwen3-30b,deepinfra-deepseek-v4.1-flash
```

This emits a plan without resolving credentials, opening a database or calling
a provider. It selects eleven fixed-evidence development cases and lists the
remaining workflow/application-policy cases as requiring separate observers.
Only the explicitly pinned bundled corpus can be used; the command accepts no
arbitrary input file. Source authorization is an operator-owned manifest of
exact source/revision identities. Case roles, entitlements and expected labels
never establish grants. Grading labels are excluded from model input.

The [VPN grounding pair](vpn-grounding-review.md) can be planned separately:

```sh
pnpm evaluate:models --profiles groq-oss-120b,gwdg-qwen3-30b --cases sit-vpn-grounding-01,sit-vpn-specificity-02 --max-calls 4
```

`--cases` only narrows the reviewed fixed-evidence manifest, preserving manifest
order and source authorization. Unknown, duplicate or non-fixed case IDs fail
before database access, report creation or dispatch. The default HTTP attempt
cap remains eight; selecting all eleven cases with that cap can yield an
explicitly incomplete report. A repair attempt also consumes the cap.

Profiles must already be selectable under server policy, eligible for
`synthetic_demo` and priced. No provider is automatically added or enabled.
The order rotates profiles between cases; repetitions are explicit (one by
default, at most three). Report the order and development split, not a blind or
randomized study. All profiles receive the same projected evidence and clock;
the adapter currently requires Europe/Berlin, matching the production router.

## Explicit observed-workflow mode

```sh
pnpm evaluate:models --profiles groq-oss-120b,gwdg-qwen3-30b --workflows
```

This is also plan-only by default. It selects only `anny-03-runtime` and
`anny-06-runtime`; `--cases` can narrow that manifest. The default fixed-evidence
mode does not silently acquire action fixtures. Unknown/static/knowledge case
IDs cannot register a workflow. The same corpus pin, approved profiles, live
opt-in, existing shared budget and HTTP-attempt cap apply to `--run`.

Each profile/repetition gets its own loopback-only Anny runtime and memory state.
The synthetic host prepares and confirms one mock booking or cancellation; the
mock commits it and deliberately loses the reply. Cancellation has one separately
counted setup booking. Instrumentation independently observes proposal transitions,
submitted argument/actor binding and persisted source execution evidence. The
model receives only `{state: "outcome_unknown", action, externalAttempts: 1}`
as frozen evidence through the existing read-only evidence envelope. It receives
no proposal IDs, confirmation events, expected labels or execute tools. This is
not a forged production action-context grant or a model-driven tool loop.

A trusted single-use observer binds the current run, case and exact model-input
digest to that fixture's independent events. Invalid/mismatched observations or
observer failure leave the case ungraded while retaining provider usage. The
operator closes the fixture on success/failure; unavailable observation or failed
cleanup stops the workflow batch with exit 2 and an explicit stop reason. Provider
errors still stop that connection without retry/fallback. No production business
service, booking or cancellation is reachable from the fixture.

The model clock/status are stable across isolated runs. Actual fixture action
dates are private and dynamic, and preparation/observation are excluded from
provider latency. These cases qualify unknown-outcome response/control behavior,
not calendar interpretation, initial search/planning, the original static cases,
all workflow families or semantic correctness. Blinded human scoring, access and
injection fixtures, approved thresholds and measured live per-profile results
remain separate M6 work. Local fake-provider tests are not live-provider evidence.

The [first ten-call unknown-outcome development run](../verification/2026-10-21/provider-unknown-outcome-run.md)
now records actual observations across five approved synthetic profiles. Its
trace/no-proposal checks pass, while developer inspection finds semantic defects.
Usage, conservative ledger charges, exact inputs and unreviewed human material
remain separate; this does not close M6 or establish a model ranking.

## Explicit live execution

Live runs require all of the following:

- `--run`, `--output <new.ndjson>`, `HASI_MODEL_EVALUATION=1` and a 40-character
  reviewed `HASI_EVALUATION_BUILD_REVISION` supplied by the operator build.
- The existing serving deployment's hidden provider variables and PostgreSQL
  `DATABASE_URL`, with verified binding to its existing shared budget ledger.
  `getDurableModelBudgetAdmission()` requires existing state; this command does
  not initialize/reset a ledger or use a fresh local budget.
- The approved shared USD 1/UTC-day policy remains in force across the serving
  application, comparison runs, repair attempts and other processes. A report
  cap never increases that policy or changes provider quotas.

The CLI requires these configuration fields; their presence alone does not
prove deployment identity or ledger binding. Verify the operator image revision
and shared-store binding against the serving deployment before spending.
Never pass secret values in command arguments, Docker build arguments or logs.
Use the established hidden runtime environment custody; do not fetch secrets
just to inspect configuration.

`--max-calls` bounds actual HTTP attempts, including a Groq repair attempt,
not just successful cases (default 8, maximum 64). The runner performs no
plugin/source execution and has no routing token or fallback authorization.
A connection stops after any error, including 429; the CLI does not retry it.
Requests on a connection are spaced by at least 30 seconds after the previous
case, or 60 seconds for GWDG. These pauses do not claim a provider quota. Other
connections can continue; budget failures stop the entire run. A cap can leave
the planned comparison incomplete; it is recorded and returns exit code 2.

The output is exclusively created with mode 0600; an existing file is never
overwritten. Each NDJSON record is flushed so completed observations survive a
later error. Raw synthetic answers are present for later blinded human review.
Raw provider error bodies, credentials and request headers are omitted. The
console emits case/profile/status/count metadata only. Exit 1 reports an
operator/contract failure, with a partial report when one was already created.

## Measurement interpretation

Every HTTP attempt has a digest and must follow an admitted reservation. Each
reservation records its conservative bounds and settlement status. Reported
input/output tokens are validated against those bounds; absent or invalid usage
keeps the conservative hold and produces null totals, never a fabricated free
call. Settlement delegates preserve late unknown-to-known reconciliation,
idempotent identical reports and conflict rejection. Unconfirmed settlement is
not reported as a known cost. The serving ledger is the spending authority.

Costs are estimates from reported tokens multiplied by the recorded approved
input/output tariff. The report includes the complete tariff snapshot, its
basis and hash, configuration/input/request hashes, model ID and build revision.
GWDG retains Fabian's approved temporary Groq-equivalent estimate; replace it
when the contractual tariff is available. These are not invoice amounts,
provider-side hard caps or cache savings. Cache state is unknown; no cache-read
counter is established here. Resolved versions of aliases are unavailable.
Latency is whole-case elapsed time, not first-token latency.

The small deterministic oracle checks only allowed/required citation identities
and absence of tool proposals. Citation tokens in code, authored links, images
or HTML nodes do not establish citation presence. This fixture token format is
not a browser-rendering/ACL proof. Citation support, factual correctness,
completeness, language and helpfulness still require the benchmark's blinded
human rubric. A passed literal assertion is not a passed semantic task.

## Operator image

The root Dockerfile has an explicit `evaluation` target containing the same
router and the pinned synthetic corpus. The default final target remains the
public web application. Neither the operator image nor this command adds a
public route, a release channel or a provider credential to the image.

```sh
docker build --target evaluation --build-arg SOURCE_COMMIT="$reviewed_commit" \
  --tag "hasi-evaluation:$reviewed_commit" .
docker run --rm "hasi-evaluation:$reviewed_commit" --help
```

`reviewed_commit` must identify the checked-out, clean, CI-qualified source;
the build argument is an operator assertion, not source attestation. Verify
actual image identity and runtime environment binding before a live run. The
ordinary app's database, sessions and budget must not be recreated for this
operator container. Do not publish a GHCR release as part of this workflow.

Remaining M6 work includes reviewed/adjudicated cases, observed workflow and
adversarial comparisons, approved decision thresholds, actual bounded provider
results and blinded human scoring. CACHE-A1 remains independently unresolved.
