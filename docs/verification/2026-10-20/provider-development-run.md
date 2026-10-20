# First bounded provider development observations

Date: 2026-10-20. Related to M6 #53. [Machine-readable observations and non-secret configuration](provider-development-run.json).

All 35 planned scenario runs completed with 35 actual HTTP attempts, no fallback,
retry, provider error or skipped run. Seven pinned synthetic fixed-evidence
cases were sent to each of five configured profiles, one repetition, in
case-major rotating profile order. No tool executor or business write was
available. Every actual HTTP call used the serving application's existing shared
durable budget admission; no ledger initialization/reset was performed.

The source and operator-image revision was
`e15f88111e40ba60fcc82aa2ecd17a6eb19cc6a6`.
Operator image ID:
`sha256:ca35c36f0332835888a4ba47462da7407621ea05b483a895d800692826b1db2e`.
The read-only pre-run store-binding probe matched the operator ledger to the
physical serving database without changing it or making provider requests.

The operator dispatch/container ID was
`d1bf4bc2-c736-4362-bfd2-fb17cf9e5b44`; the CLI independently generated report
run ID `f497fd19-7c92-4973-883a-175f4c7903bd`. These identify the same execution,
not two model runs. Start: 16:37:37.263 UTC; finish: 16:47:49.733 UTC.
Raw synthetic answer report SHA-256:
`8fab31cc28f3e019971bdc19c6fac1b2ee478ef664bfa5abb53250ea34d31876`.
The private report is mode0600 on the HASI host and in the operator's local copy.
Case/profile coverage, one common configuration digest, identical per-case
projected input identities across profiles, complete usage and final actual
request count were checked against that frozen report.

| Profile | Literal assertions passed | Input / output tokens | Estimated USD | Whole-call median ms |
| --- | ---: | ---: | ---: | ---: |
| groq-oss-120b | 6/7 | 10026 / 852 | 0.00201510 | 645.91 |
| groq-oss-20b | 7/7 | 10026 / 770 | 0.00098295 | 557.27 |
| groq-qwen-3.8-27b | 6/7 | 9919 / 822 | 0.01122320 | 471.14 |
| gwdg-qwen3-30b | 6/7 | 11783 / 1168 | 0.01409840 | 2552.3 |
| deepinfra-deepseek-v4.1-flash | 7/7 | 11648 / 1011 | 0.00293620 | 2534.81 |

All usage observations were complete. Estimated cost totals USD0.03125585 at the
recorded configured tariffs. GWDG's USD0.01409840 share uses Fabian's approved
temporary Groq-equivalent operator estimate; it is not GWDG invoice evidence.
The shared ledger may charge more conservatively than per-profile estimates.
After completion a second read-only probe matched the same physical shared
ledger and did not alter it. The snapshot now contains 43 reservations (8 before
this run), 102,083 input / 6,984 output tokens, and 109,618 micro-USD conservatively
charged against the 1,000,000 micro-USD UTC-day limit. The one pre-existing
unresolved/unknown reservation remains one; the 35 completed calls introduced
no unknown usage. These later legitimate reservations are not a failure of the
separately captured pre-deployment state-preservation comparison.

Medians describe seven answer-only calls each, not first-token latency, a
percentile qualification, local UI responsiveness or a model ranking. DeepInfra
also used a different configured temperature; see the configuration snapshot.

## Observed defects and interpretation

- Groq Qwen3.8 omitted the required citation in `sit-01` while providing the
  requested ticket fields and synthetic disclaimer.
- Groq GPT-OSS 120B used unsupported Unicode citation delimiters in `intra-02`;
  the source was named in text but was not a usable canonical citation token.
- GWDG Qwen3 30B omitted the citation in `sit-03`. Developer inspection also
  found unsupported general MFA steps and the invented support address
  `https://serviceit.hsh.de`, absent from the supplied evidence. This is a
  concrete grounding defect, not an approved support destination. The literal
  oracle does not itself assess all unsupported links or semantic claims.

These observations are not blinded human adjudication. The current assertions
check authorized/required citation presence and no tool proposals; a literal
pass is not a quality or safety pass. The corpus is draft development material,
not gold or held-out data. Thirteen workflow/access/injection cases were
explicitly excluded from this answer-only path. The separate user-reported
workplace/topic-switch/booking and invented VPN-fixture instruction failures
remain open. The observed lexical retrieval defect was corrected separately in
[PR #151](https://github.com/metaneutrons/HASI/pull/151); this answer-only run
does not qualify that search path or prove those dialogue failures corrected. No institutional processing, complete M6 acceptance, provider-cache hit,
token-cache savings or immutable provider alias version is established.

Next: review the frozen synthetic answers with a blinded human rubric, curate
and adjudicate expected results, add case-specific workflow/access/injection
observations and qualify unsupported-link/grounding behavior. No prompt or
configuration was changed during this run to improve the observed scores.
