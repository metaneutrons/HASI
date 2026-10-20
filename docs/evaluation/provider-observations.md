# Fixed-evidence provider observations

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
a provider. It selects seven fixed-evidence development cases and lists the
remaining workflow/application-policy cases as requiring separate observers.
Only the explicitly pinned bundled corpus can be used; the command accepts no
arbitrary input file. Source authorization is an operator-owned manifest of
exact source/revision identities. Case roles, entitlements and expected labels
never establish grants. Grading labels are excluded from model input.

Profiles must already be selectable under server policy, eligible for
`synthetic_demo` and priced. No provider is automatically added or enabled.
The order rotates profiles between cases; repetitions are explicit (one by
default, at most three). Report the order and development split, not a blind or
randomized study. All profiles receive the same projected evidence and clock;
the adapter currently requires Europe/Berlin, matching the production router.

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
