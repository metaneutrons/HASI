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
The probe does not alter prompts, routing, model parameters or safety policy.

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
