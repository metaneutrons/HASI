# Room-planning development observations

`evaluate:room-planning` observes one code-owned development scenario:
`room-initial-preference-1j`. It sends an initial request using **Büro** for an office in
building 1J from 10:00 to 16:00 on a Berlin date generated about seven days
ahead from the current runtime clock. The model must normalize the office request
to a workplace search; the input does not supply that tool argument. After the
initial protected chat route returns a typed search call, the operator executes that read through the native
Anny chat bridge. It then stamps the direct `mir egal` follow-up and uses the
same `classifyIntent`, `mergeRoomRequest`, and `officePreferenceSearch` host
helpers as the browser to issue a second search without another model call.

The CLI is plan-only unless `--run` is explicit:

```sh
pnpm evaluate:room-planning --profiles groq-oss-120b --cases room-initial-preference-1j --max-calls 4 --repetitions 1
```

Plan-only mode validates selected configured profiles and the fixed case. It
does not create the local fixture, call `fetch`, inspect credentials, or open
the budget store. To request a live observation, an operator must also set
`HASI_MODEL_EVALUATION=1`, provide a pinned 40-character lowercase hexadecimal
`HASI_EVALUATION_BUILD_REVISION`, use the existing shared `DATABASE_URL`, and
choose a new output path:

```sh
HASI_MODEL_EVALUATION=1 HASI_EVALUATION_BUILD_REVISION=<reviewed-40-hex-revision> \
  pnpm evaluate:room-planning --profiles groq-oss-120b --cases room-initial-preference-1j \
  --max-calls 4 --repetitions 1 --run --output ./private-room-planning.ndjson
```

The operator opens existing durable budget admission before it creates or
configures the local fixture. It does not initialize, reset, or refund budget
state. The new NDJSON file is created exclusively with mode `0600`, and each
record is synced. The report and model text are private evaluation data. The
ordinary console output contains only plan metadata or per-case status and
usage summaries. Errors use the generic operator message and do not expose
provider responses, credentials, database URLs, or local signing material.

The initial message goes through the actual timestamp POST and protected
`createChatPostHandler` route, using the selected approved configured profile
and the supplied shared admission. The operator captures the configured
provider request and bounded response, then checks the actual returned route
reply before any tool execution. Capturing a provider proposal never grants
authority. Only a single schema-valid `anny_search_resources` call for
`kind: workplace` and `location: 1J` can reach `createAnnyChatTools`. The
read-only fixture grants only `rooms:read`, exposes `AnnyClient` with writes
disabled, and also blocks/counts recognized proposal, confirmation, execution,
and cancellation attempts. The fixture explicitly supplies replay and execution-
journal interfaces from an isolated per-fixture memory store, including when the
operator image uses `NODE_ENV=production`. This does not establish durable
production execution state. Its HTTPS Anny contract origin is handled exclusively
by the injected local mock transport; it makes no DNS or external TLS request.
Availability checks, proposals, confirmation, cancellation, and booking execution
are outside this scenario.

Each read receipt is tied to the typed tool arguments and returned tool result
by SHA-256 digests, and includes the corresponding actual API and Anny source
observations. The report separately records timestamp creation times, the
runtime-generated calendar input, configured profile/configuration identities,
captured provider text and proposals, every admitted provider HTTP attempt,
budget usage/settlement state, caps, observation truncation, blocked writes,
prepared proposal count, fixture cleanup, and restoration of process-global
fetch/environment instrumentation. The operator performs no independent source
probe. Missing reads, unexpected or invalid calls, text-only output, partial or
unrecognized capture, HTTP errors, rate limits, unknown/unconfirmed usage,
write attempts, truncation, cap exhaustion, or cleanup/restoration failures
stop the batch. A model that omits the required search is recorded as
`scenario_not_exercised`; it is not a safe or successful semantic result.

This is an engineering observation of one initial office search and one direct
preference refinement. The fixture's synthetic TestIdP identity, account
mapping, and fixed catalog are not production authorization or model-visible
expected answers. The operator does not claim full React/browser coverage,
general calendar coverage, semantic correctness, model ranking, gold status, or
M6 acceptance. Human review remains required. Provider cache status is unknown;
Groq cache evidence remains deferred to M8-A10.
