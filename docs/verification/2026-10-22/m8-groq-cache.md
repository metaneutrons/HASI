# M8-A10 Groq cache control — 2026-10-22

**Result:** no positive cache-read counter was supplied by the provider. M8-A10 remains open; saved tokens and cache-related cost savings are unknown.

## Bounded live control

The existing operator command `probe-groq-cache.ts plain` sent exactly two sequential requests to Groq `openai/gpt-oss-120b` at the approved Groq OpenAI-compatible endpoint. Each body was 13,474 bytes, with the same complete SHA-256 `65545153f10f8b59832b573a7bf468f55b5c7d48e416dcc8c5546d7377693cf1`. A single nonce was fixed before the pair; the synthetic catalog, model, messages, output cap and parameters did not change. There were no HASI instructions, tools, timestamps or SDK response normalization in the request path.

| Request | HTTP | Input tokens | Output tokens | Documented cache counter | Alternate cache counter |
| --- | ---: | ---: | ---: | --- | --- |
| 1 | 200 | 3,315 | 15 | missing | missing |
| 2 | 200 | 3,315 | 18 | missing | missing |

Both missing fields are unknown, not zero. Identical complete requests and removal of HASI prompt structure did not make the provider return a cache counter. Thus changing HASI prefixes cannot alone explain this observation; account/service eligibility or provider behavior remains unestablished. This does not prove either a cache hit or a cache miss. No further paid retry was made to force a hit, no other model/key was substituted, and no support message was sent.

[Groq's current prompt-caching documentation](https://console.groq.com/docs/prompt-caching), checked 2026-10-22, lists GPT-OSS 120B as supported and requires matching prefixes; actual hits are not guaranteed. The observation above does not establish why the documented counter was absent.

## Transport, identity and accounting

Before the live pair, the packaged transport ran with network disabled and a fake provider: a supplied positive counter of 1,200 was observed, both reservations settled, and a third attempted request was rejected by the two-call cap. The current local transport suite also passed all 17 positive/counter cases. This control establishes that the raw observer can detect a counter when one exists; it is not a real provider hit.

The read-only, capability-dropped operator image was `sha256:9ce06ebb23d71dbe894540b68ef7ca9b5ac3e68e8fc8518b363ee43c25773c05` from `f0fe2602d85d5b808566ec23a43abe42b31c1f55`. Its probe, transport, configuration, pricing and budget sources were hash-checked against the current baseline. Only README/verification prose differs between that operator revision and serving baseline `b52598d705f938e52213c5bbd7691735bf7e3399`. The sole serving image was healthy and matched that baseline; its runtime database binding was independently checked against the existing database container before admission.

The two requests used the existing shared durable USD1/day ledger. The conservative counter increased from 308,040 to 313,476 microUSD (5,436 microUSD); two new reservations settled. All seven pre-existing unknown holds and 570 still-active non-budget records were retained unchanged. No fresh ledger, allowance, refund, session reset or real business write was used. The operator container stopped after the bounded run. The raw numeric-only event capture SHA-256 is `4487729fddee06f2a60b5b2a9cb05d413c8511a809ef1a71e257bc5f72bbbbe2`; [the result JSON](m8-groq-cache-result.json) retains request hashes, observations, image/source identities and retention counts. Run ID: `e696d4c6-fbcc-4abb-8d5d-500573b07ebe`.

Two earlier operator-preflight attempts stopped before any provider dispatch: a blank Docker-template line and a misnamed local reservation identity field were corrected. They are not cache evidence and caused no provider call or budget reservation. The packaged fake-counter/cap control passed before the live run.

The control bypassed the AI SDK and normal HASI tool workflow, so it does not newly qualify raw-to-SDK accounting or a live HASI-prefix hit. A complete M8-A10 pass still needs the actual positive raw counter and the remaining exact-model/environment/prefix and raw-to-SDK evidence from the unchanged plan. The retained small observation is suitable for a provider inquiry; its cause must not be invented.
