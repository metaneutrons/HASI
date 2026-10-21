# Observed unknown-outcome provider development run

Date: 2026-10-21. Status: completed bounded development observation; semantic
review and M6 acceptance remain open. This is not a blind/repeated comparison,
a model ranking, the supplied complete room/VPN dialogue or institutional acceptance.

## Exact execution boundary

Run `936b5b8e-b8a6-4afa-91d1-41d982f24e6a` used the operator image built from the clean,
CI-qualified PR194 head `621fd6c2d76a383feab8b30db9546df368ba6b66`. Its tree matches
serving merge `13fe0d0e58c26787ad39cf5f3de50b5970339a92`. Image identity is
`sha256:3d4525b54cc7eb91810ac7e2491c9a7b7173113b1ad93152974a8d38f9cf545e`. The actual server operator is Linux x64,
Node 24.22.0, non-root `node:node`; eight source/lock/corpus hashes match the
reviewed Git objects. This is distinct from the prior Linux arm64 local container
proof. Full identities, actual request hashes, tariff snapshots, observation
hashes, usage and source verification are preserved in [the result](provider-unknown-outcome-run.json)
and the [durable original readback](https://github.com/metaneutrons/HASI/pull/194#issuecomment-6326650438).

A network-disabled/read-only/no-credential operator plan selected only the two
registered runtime variants, five already approved synthetic profiles and ten
HTTP attempts. Before spending, the operator's physical shared ledger was matched
to the serving app using its existing hidden environment, with USD1/UTC-day policy
and no initialization/reset. Runtime secrets remained in the trusted process
environment; none entered prompts, tracked data, arguments or reports.

The live container was read-only/non-root, with a small temporary filesystem,
no added capabilities or Docker socket, and one private report mount. It shared
the serving network namespace to reach the existing budget database; this is
not a network-isolation proof or a newly provisioned provider/database account.
The registered fixtures use separate in-memory state and loopback mock services.
Production business/tool services are never invoked by these fixtures.

## Frozen cases and observed effects

`anny-03-runtime` and `anny-06-runtime` each ran once per profile. Every instance
uses its own actual mock proposal/confirmation/execution setup; the source commits
and loses its reply. Cancellation has a separately accounted setup booking.
The model receives only the frozen sanitized unknown status as evidence, with no
proposal IDs, confirmation authority or execute tools. An independent single-use
observer binds the exact case/input/run to the actual fixture trace. The original
static cases and production action-context path are not silently substituted.

All five profiles receive the same projected input per case:

- Booking: `ba33a46c6623229d0a3327c0091c91d0f3d4fca08457057d5107b32dbcb459eb`.
- Cancellation: `5de42f5b0e16e40e9b055944a280bb5b55bfa6958506bf645b1e8dfb6436bfbe`.

The shared configuration digest is `70627c5be0361af8f4b3a625ae30e3010ad2c8b31506a27e58556102831d22ce`.
The matching configuration snapshot preserves all five profiles' parameters,
capabilities and data classes, three resolved provider destinations and routing
policy. It excludes credentials and credential references; recording it made no
provider call or budget access.
The model clock/status are fixed; private dynamic fixture action dates are not
calendar evidence. Provider wire hashes differ by adapter/profile as expected.
No resolved immutable upstream alias version is available.

The reviewed case-major rotating order completed **10 scenarios / 10 actual
HTTP calls / 10 answers**, with zero provider errors, repair/fallback attempts,
skipped/unexecuted cases or failed cleanup. The ten distinct workflow run IDs
and per-case input identities match. Connection spacing and request cap were
retained; this sample does not establish provider rate-limit capacity.

All ten observed-trace/no-proposal checks pass. They establish the bounded
application trace and absence of model tool proposals, **not response semantics**.
No model executor is exposed, so this cannot qualify initial search/planning,
calendar interpretation, complete confirmation/cancellation dialogue, actual
reconciliation UX or source/access/injection behavior.

## Usage, cost and state preservation

| Profile | Input tokens | Output tokens | Estimated USD | Case latency (ms) |
| --- | ---: | ---: | ---: | --- |
| `groq-oss-120b` | 2853 | 230 | 0.00056595 | 718.942, 752.738 |
| `groq-oss-20b` | 2853 | 173 | 0.000265875 | 582.414, 940.342 |
| `groq-qwen-3.8-27b` | 2807 | 391 | 0.0038096 | 669.451, 750.522 |
| `gwdg-qwen3-30b` | 3349 | 178 | 0.0033912 | 3295.743, 2235.451 |
| `deepinfra-deepseek-v4.1-flash` | 3356 | 341 | 0.0008758 | 2630.202, 2244.872 |

Each row aggregates two responses; latency lists the two measured case durations,
not a percentile, first-token latency or queue-inclusive user workflow duration.
Fixture preparation/observation and scheduler spacing are excluded.

All reports include complete usage: **15,218 input / 1,313 output tokens**.
Configured-tariff estimate: **USD0.008908425**. GWDG retains Fabian's explicitly
approved temporary Groq-equivalent tariff; these are not invoice amounts or a
contractual price verification. The physical conservative ledger charges its
maximum approved rates and rounding, so its delta is **17,431 micro-USD** rather
than the per-provider estimate.

The existing ledger moves 38→48 reservations, preserves all four prior unknown
holds, and totals **163,289 / 1,000,000 micro-USD** for the same UTC window.
Operator/serving physical-ledger fingerprints match before and after. All 553
non-budget baseline records are unchanged, with zero missing/changed/expired
baseline records and the same physical database/volumes. No reset, replacement
store or refund of previous unknown usage occurred.

Cache is unknown in all ten results; there is no demonstrated cache hit or token
saving. CACHE-A1 remains deferred intact to M8-A10 under Plan V9.

## Semantic findings and human handoff

Developer inspection identifies concrete concerns despite the passed structural
checks. GWDG asks for repeat confirmation before status reconciliation in both
cases. Groq20B describes unknown actions as incomplete and the booking as still
active. Other responses include unsupported or ambiguous recovery guidance.
These are retained unadjudicated development findings; no production action was
repeated and no semantic pass rate, human score or model ranking is assigned.

A separate anonymized packet contains all ten unchanged responses, complete
projected status inputs and empty claim-level rating forms. All ten input digest
matches, answer round-trips and one-byte alteration counterprobes pass. Raw private
NDJSON SHA-256: `fbbeb7f82e43c3873b049e895c3f9c72a30ae873d63af705874f1d29491e78d7`; packet Markdown SHA-256:
`dc503c8efa31bf351329c18dd36e914a341130573d3fceeebc48962c42223d9a`. Provider mappings remain outside the review
packet. The earlier eight-answer knowledge packet is unchanged. Both packets
remain unreviewed; critical findings require a second independent human review
and adjudication. No draft is promoted to reviewed/adjudicated/gold status.

Remaining M6 work includes those human reviews and approved thresholds, observed
per-profile source/tool injection and access/model-switch fixtures, the remaining
full initial room-planning/calendar/dialogue cases, and the formal decision report.
The public demo default/profile policy is unchanged by this observation. Protected
data/provider approval and real institutional integration remain M8.
