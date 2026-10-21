# Groq prompt-cache measurement

Date: 2026-10-18. The implementation PR records exact-head CI, deployment and
live observations; local fixtures alone do not prove a provider cache hit.

## Measurement contract

A successful Groq generation adds an optional `cache` object to the existing
content-free `HASI model usage` server log. The chat response remains compatible
with existing strict clients. No new UI, endpoint or credential is required.

| Field | Meaning |
| --- | --- |
| `inputTokens` | Total provider-reported input, including cache reads |
| `cache.readTokens` | Input tokens Groq reports as served from cache |
| `cache.uncachedTokens` | Total input minus reported cache reads |
| `cache.readRatio` | Cache reads divided by total input; omitted for zero input |

Groq reports `usage.prompt_tokens_details.cached_tokens`. Installed
`@ai-sdk/groq` 4.0.62 maps it to
`result.usage.inputTokenDetails.cacheReadTokens`; `ai` 7.0.142 preserves absence
versus explicit zero. The adapter synthesizes a zero total when `prompt_tokens`
is missing, so HASI requires an explicitly reported raw `prompt_tokens` as well.
Only that numeric property is read; raw provider usage is never logged.

Both counters must be nonnegative safe integers, with reads no greater than the
total. Missing/null/invalid counters omit the complete cache object; they are
unknown, not observed misses. An explicit zero is retained. Other adapters are
not assigned these Groq semantics until independently qualified.

For an observed period, sum `cache.readTokens` to count reused tokens. Compute
the weighted cache share as `sum(cache.readTokens) / sum(inputTokens)` only over
records with reported cache metrics. Report the unmeasured record count
separately; do not average per-request ratios or turn unknowns into zeros.
A request-level hit is a reported `cache.readTokens > 0`.

Usage covers the successful generation only. `attempts` still records a repair
or fallback; failed generations can consume unreported tokens. Do not present
these measurements as complete account usage or a billing ledger.

## Interpretation

Groq supports automatic prompt caching for GPT-OSS 120B. Exact common prefixes,
supported models and provider routing determine hits; cache reuse is not
guaranteed. Constant instructions precede changing calendar/time data in HASI.
The production prompt and routing are unchanged by this investigation. The explicit operator controls below freeze time or use a separate synthetic prompt; they do not execute tools.

Reused tokens remain part of the transmitted prompt. They do not represent a
shorter context or reduced output generation. Groq currently documents a 50%
discount for cached input; a cache-token share is therefore not the same as a
total request-price reduction. No monetary saving is inferred here. Groq also
excludes cached tokens from quota after processing; parallel requests can still
hit admission limits before the deduction.

Source: [Groq prompt caching](https://console.groq.com/docs/prompt-caching).

## Verification procedure

Unit and fake-transport tests distinguish an explicit miss, positive reuse,
unknown/missing totals, invalid/oversized counts, zero input, unqualified
compatible adapters, safe telemetry and failed regeneration usage. A positive
fixture (1,200 of 1,600 tokens) and a zero fixture produce different results;
the measurement is not an always-zero probe.

For live qualification, use two fresh Groq GPT-OSS 120B chats with the same
synthetic office request and tool scope, sequentially within a short interval.
Record provider totals and cache telemetry for each generation; confirm one
model round per request and no regeneration or fallback. Neither the first
request nor a new browser chat guarantees an empty provider cache. Positive
reported reads prove reuse for those calls; zero or missing reads do not prove
caching is unavailable. Stop on quota errors and honor Retry-After instead of
retrying to force a hit. Use only synthetic data and no vendor writes.

## Raw-response investigation

Live controls on 2026-10-18 observed the response **before** AI SDK parsing.
All requests used the provisioned Preview credential in authenticated, separate
Preview builds; it was not downloaded or compared with the Production secret.
These builds were never promoted to Production. Temporary build commands were
restored locally after upload; ordinary builds never invoke the probe.

| Control | Exact body repeat | Input tokens per call | Output tokens | Raw cache counter |
| --- | --- | --- | --- | --- |
| HASI GPT-OSS 120B, frozen clock and verified user timestamp, 3 scoped anny tools | yes, 2 calls | 2,337 / 2,337 | 135 / 75 | missing / missing |
| GPT-OSS 120B, independent synthetic catalog, no tools or clock | yes, 2 calls | 3,316 / 3,316 | 15 / 15 | missing / missing |
| GPT-OSS 20B, independent synthetic catalog, no tools or clock | yes, 2 calls | 3,316 / 3,316 | 16 / 17 | missing / missing |

Every response was HTTP 200. HASI calls each used one generation, with no repair
or fallback. Both the documented `usage.prompt_tokens_details.cached_tokens`
and the separately inspected `usage.cached_tokens` were absent in all six raw
responses. The latter is diagnostic only, not a substitute for the documented
field. The SDK likewise produced no cache-read counter for the HASI pair.
[Sanitized evidence](groq-cache-controls.json) records deployment IDs, selected
counters, byte counts and hashes of synthetic request bodies only.

**Finding:** the missing counter originates upstream of our SDK. The installed
SDK mapping is not the cause in these observations. Frozen, byte-identical
requests remove clock changes and changing tool scopes as explanations for
these control pairs. Both repeat prefixes exceed Groq's published maximum
minimum length of 1,024 tokens. This does not prove that Groq performed no
internal reuse; it proves that **no measurable cache hit has been established**.
The underlying account/backend/routing reason is still unknown. The docs do not
guarantee a hit and do not establish a Free-versus-paid eligibility distinction.
No tier change, new key, routing trick or further retry loop was used.

### Prompt-prefix audit

The fixed application instructions contain 3,890 characters / 3,963 UTF-8 bytes.
They precede the changing Berlin clock (including seconds), current calendar
anchors and per-user-message verified timestamps. Thus a changed clock breaks
the common prefix before later timeline/history content. The fixed tool schemas
are stable within a scope, but scopes deliberately differ for rooms, own
bookings, knowledge and mixed tasks. JSON property order does not prove the
provider's internal token order or the placement of tool schemas.

The fixed instruction text encodes to **876 ordinary GPT-OSS tokens**, excluding
provider-added role/template/tool overhead. This was verified against the
[official tokenizer](https://huggingface.co/openai/gpt-oss-120b/blob/main/tokenizer.json):
all 199,998 ordinary vocabulary entries match the locally cached o200k_base
ranks; both pretokenizers produce the same 614 chunks for this exact prefix,
which contains no added special tokens. The compatible local worker counts 876.
This is a text-prefix count, not a measurement of Groq's rendered common prefix.
It is below the upper end of the documented 128–1,024 model-dependent minimum;
Groq does not publish the exact GPT-OSS 120B threshold here. Neither character
counts nor this text-only count prove that the complete rendered prefix is too
short or sufficiently long.
Moving text into a second system message alone does not increase the common
prefix. Freezing real user timestamps, padding live prompts, advertising every
tool on every turn or moving untrusted content into privileged instructions are
not appropriate fixes. Keep accurate dates, narrow tool scope and authorization
boundaries. A future change that appends trusted current-turn metadata after a
stable conversation must be separately qualified for message semantics and
relative-date correctness.

The stable prefix can be improved, but prompt rearrangement alone cannot explain
or resolve the raw-counter absence in the independent controls above. Before
claiming cache savings, ask Groq to clarify cache eligibility/routing and missing
usage details for the account/model using these timestamps and sanitized cases;
then repeat the bounded control and require a positive documented counter.
No support message has been sent.

### Reproducing the operator controls

From the repository root, with the key and shared database connection already
injected into the server process by their approved secret store, and the
[shared budget ledger explicitly initialized](../../architecture/model-budget.md):

```sh
pnpm probe:groq-cache hasi
pnpm probe:groq-cache plain
pnpm probe:groq-cache plain-20b
```

These are separate explicit runs, not a suite or an automatic fallback. Run only
one pair at a time and leave the required quota budget before another run.
The M2 candidate now reserves each actual network attempt, including plain
controls, against the same durable daily ledger. Missing state fails closed;
there is no process-local budget fallback. This added admission path has mock
regression coverage; no new live cache experiment was run for that change.
There is no key CLI argument, environment download, public probe endpoint or
normal build hook. Do not paste a key into a command. The Preview builds described above are historical. Vercel is retired and must
not be used as the current credential or probe environment. Current credentials
remain in encrypted fnox custody and hidden Coolify runtime configuration. The
standalone application image does not include these operator source scripts;
an approved source checkout or a separately qualified diagnostic image is needed
before executing a live control with the approved secret abstraction and shared
ledger. This record does not claim that path has been qualified on the new host.

`hasi` freezes one server clock for both calls and compares raw usage to the
normal router/SDK metrics. `plain` and `plain-20b` send a fixed, entirely
synthetic catalog with a once-per-run nonce; each pair's complete request bodies
are identical and generation is capped at 64 tokens. Plain controls bypass the
HASI router to isolate provider behavior and never process user/source content.
The endpoint and model choices are fixed in operator code, not client input.
No control executes returned tools or business actions.

Each process caps all network calls at two, including any HASI repair attempt,
rejects other endpoints and redirects, uses timeouts, and stops on an error
(including 429) without retrying. Observation retains/parses at most 65,536 response bytes; an individual stream
chunk may cross that limit and is rejected before accumulation/parsing. Logs contain selected numeric counters/states, approved router metrics
and synthetic-body equality/hashes; no request/response text, secret, header or
raw usage object is printed. Missing/null/invalid numeric values remain distinct.
Successful process exit means the measurement completed, **not** that a cache
hit occurred. A validated documented read count greater than zero is required
for that claim; latency or identical generated text is insufficient.


## Documentation recheck — 2026-10-19

The [official Groq caching documentation](https://console.groq.com/docs/prompt-caching)
still describes automatic, non-guaranteed cache reuse for GPT-OSS 120B/20B and
reports reads through `usage.prompt_tokens_details.cached_tokens`. It does not
explain this account's observed missing field. The existing raw-response control
results therefore remain unknown, not zero reads or an established hit.
No new paid/provider control was made for this documentation recheck.

The separate JSON-schema compiler optimization reuses local validation programs.
It supplies no evidence about Groq prompt caching, saved model tokens or billing.
CACHE-A1 remains governed by the versioned plan and the current M6 issue until
its genuine provider evidence or an explicit scope decision is recorded.


## Documentation recheck — 2026-10-21

The [official Groq caching page](https://console.groq.com/docs/prompt-caching)
still lists GPT-OSS 120B/20B, automatic non-guaranteed prefix reuse and the
`usage.prompt_tokens_details.cached_tokens` counter. The documented requirements
remain exact prefixes and a model-dependent minimum of 128–1,024 tokens. This
documentation-only check does not explain the stored raw responses with missing
counters. Those observations remain unknown; no new live probe, cache hit or
savings is claimed. CACHE-A1 still needs genuine provider evidence or an explicit
scope decision.
