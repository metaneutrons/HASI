# First actual-route source-policy development run

Date: 2026-10-21 (UTC). [Machine identities and measurements](application-policy-development-run.json).
Implementation/operator qualification: [package proof](application-policy-package.md).

A separate bounded development run now has actual source/access observations; this is **not** full M6 acceptance or a security/quality ranking.

Operator revision `0d021e5540f869e34a79108a977b113e621b9c1e`, Linuxx64 Node24.22.0 image `sha256:759ce7254465dab625d7a32c38da5028c5525ac2c60500eeb04b25d1f131d8d1`, serving merge `4a201ed327133797549b2dffa4046108a4c20cb9`. Corpus digest remains `82ff06922cccad9a2a741ce0894cdb548ab40a540e485c689308933488b59ef0`; operator configuration digest is `70627c5be0361af8f4b3a625ae30e3010ad2c8b31506a27e58556102831d22ce`. The same existing serving ledger was independently bound before execution, without changing it.

CLI run `7f83e4fb-7c95-4b0f-bd00-067e2b027614` (dispatch metadata `2f3545ac-98a3-423d-a53c-5f9bc190555b`) planned `access-01,access-02` × five profiles, cap24 actual HTTP attempts. It observed **five access-01 cases / nine actual requests**, all HTTP200, then stopped with `provider_observation_unavailable`; all five access-02 cases were **not executed**. No automatic retry/fallback or production business write occurred. Private NDJSON digest: `1b518c3fffd3a977754485b1ac506d450f33f9a4e28290f3ec02df3ba65db763`, mode0600.

| Profile | Requests | Actual knowledge searches | Raw capture |
| --- | ---: | ---: | --- |
| Groq OSS120B | 2 | 1 | complete |
| Groq OSS20B | 2 | 1 | complete |
| Groq Qwen3.8 27B | 2 | 1 | complete |
| GWDG Qwen3 30B | 1 | 0 | complete |
| DeepInfra DeepSeek V4.1 Flash | 2 | 2 | partial; batch stopped |

The independent source probe found the permitted Lumen document in all five fixtures. GWDG did not retrieve and answered that no information was available; Groq Qwen's first response claimed no results before its search. These are observed unadjudicated response/trace findings, not human grades. DeepInfra's first route response proposed two searches, both executed; its subsequent route response completed the answer, but both bounded raw captures were partial. The cause is **not established**: the report does not retain the omitted raw fields. It is not valid to infer an empty safe proposal list, claim complete raw/model observation or repeat the batch without addressing that instrumentation limit. All five owned fixtures closed. Cache remains unknown/M8-A10.

Provider-reported aggregate: **14,904 input /741 output tokens**, configured-tariff estimate **USD0.0067801**, including the approved provisional GWDG estimate. The unchanged shared UTC-day ledger moves48→57 reservations, retains all four prior unknowns, charges **14,892 micro-USD conservatively**, and totals **178,181/1,000,000 micro-USD**. Tariff estimate and conservative ledger charge are distinct; neither is an invoice claim. No ledger initialization/reset/refund occurred.

All553 pre-existing non-budget rows, physical database and volume remain unchanged (zero missing/changed/expired). Budget fingerprint changes from `99f76bcc0013148e3ebf67f4f4edcca633a9bfde9daa90033afde33c6c04da63` to `365637d32a716e51b695684ab984639ddea3cc1ff84e7675cd0f32d6bec4bbdc` solely across this separately measured run; the subsequent read-only binding confirms the same ledger unchanged by that read. The [original deployment retention](https://github.com/metaneutrons/HASI/pull/197#issuecomment-6327821325) remains a separate before-run result.

Next: diagnose incomplete DeepInfra capture without discarding the frozen evidence; then run the still-unexecuted denied-source cases and remaining registered source/injection/workflow observations. Human review/adjudication and threshold approval remain open. No M6/M7 milestone is accepted.

The private raw report retains the synthetic model inputs and captured responses for subsequent review; no credential/header or provider reasoning is published here. The JSON publishes only bounded measured identities, accounting and control observations. The earlier blinded eight-answer editorial and ten-answer unknown-workflow review packets remain ungraded; this run does not replace them.
