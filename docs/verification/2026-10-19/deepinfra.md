# DeepInfra implementation and qualification

Date: 2026-10-19. Scope: DI-A1–DI-A4, issue #81. Base: main
`d61e069d95be7f8278e87a3661ef68b9d1704d89`. This record distinguishes
implementation, offline tests and deployed provider behavior.

## Implementation

The server-owned `deepinfra-demo` connection resolves only
`env:DEEPINFRA_API_KEY` and pins `https://api.deepinfra.com/v1/openai` through
the existing OpenAI-compatible adapter. The exact requested model is
`deepseek-ai/DeepSeek-V4.1-Flash`; no dated replacement is substituted.
The bundled explicit user-choice policy includes the Experimental synthetic-only
profile. Groq stays the default, GWDG stays manual and fallbacks remain empty.
The UI, chat wire schema, operator example and JSON Schema accept the new provider.

The credential exists in encrypted fnox custody. A credential-authenticated
read-only `/models` request confirmed the exact model ID on 2026-10-19; this
is not an inference or tool-compatibility check. The hidden runtime-only
Coolify variable was provisioned for the existing main application without a
deployment. Coolify also creates a preview copy automatically; both copies
were checked hidden, runtime-only and excluded from build inputs. No credential
value, fragment or fingerprint is included here.

## Pricing and bounds

The [model card](https://deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash) showed
standard USD 0.20 input / 0.60 output per million tokens on 2026-10-19, alongside
promotional USD 0.14 / 0.42. Admission uses standard uncached rates and no
promotional/cache discount. The shared ledger still charges the highest
approved rates (USD 0.80 / 4.00), so the existing USD 1/day policy and
consumption remain valid. This is conservative accounting, not an invoice.

The profile uses temperature 1, max output 1,536 and timeout 45 seconds.
No reasoning parameter is assumed across model versions. Generic DeepInfra
[reasoning documentation](https://docs.deepinfra.com/chat/reasoning) states that
reasoning tokens are billed as output. Usable native tool arguments, generation
within these bounds and raw usage still require the deployed probe.

## Offline verification

- 127 targeted model configuration/router/budget tests passed, including
  DeepInfra credential isolation, missing key, explicit user-choice denial,
  forged client origins/references, redirect refusal, 401/429/500 errors,
  malformed tool arguments, native anny tool round trip, timestamp context,
  usage settlement and preservation of existing ledger consumption.
- Full PostgreSQL-backed coverage run: 775 tests in 88 files passed; lines
  87.12%, branches 75.57%. The database was isolated and local, not production.
- Full TypeScript typecheck, web ESLint, backend build, production Next.js build,
  offline reference packaging preparation and operator example validation passed.
- Independent read-only review found no credential/routing/budget blocker. Its
  schema endpoint-bound and stale README observations were corrected before commit.

## Remaining gate at the offline implementation checkpoint

DI-A2 and DI-A4 remain open: run a bounded synthetic chat and anny tool round
trip through the exact deployed revision, prove missing-key behavior and
sanitized failures, and retain actual model/config/revision/usage evidence.
No model inference, automatic fallback, production Anny write, protected HsH
processing or budget reset was performed by the offline qualification above.


## Deployed qualification — 2026-10-19

PR #85 merged as `c98b7c29f08e4e42daa55294dddf9c157a24d326` after all five
exact-head checks passed at `9c443c04132070dd77467097788000c90f922540`
([CI 39204627581](https://github.com/metaneutrons/HASI/actions/runs/39204627581)).
[Exact-main CI 39204951333](https://github.com/metaneutrons/HASI/actions/runs/39204951333)
also passed. The #79 controller automatically deployed that revision through
Coolify deployment `pr9as4s3gkhb88mcykawlnkd`; journal phase `completed` and
public readiness matched the exact main SHA. Runtime image:
`sha256:0bbd977c2d2db7dcaee06cca1ff07ee8d08d7ac90fcb893dbe1318a73f69fdc9`.

The deployed application has no `HASI_LLM_CONFIG` or custom-model override.
Bundled configuration digest (JSON serialization, SHA-256):
`70627c5be0361af8f4b3a625ae30e3010ad2c8b31506a27e58556102831d22ce`.
Pricing digest:
`12bc5e372856ca9fad0f17c8399a30904e1aafaea1e7f52db6c3cbf8a83169b0`.
These identify public configuration, not credentials. Groq remains the default;
manual DeepInfra selection and empty fallback rules were verified.

Two bounded synthetic model calls used the deployed authenticated Chat API:

| Case | Reported input/output tokens | End-to-end model request latency | Result |
| --- | --- | --- | --- |
| German assistant greeting | 3,563 / 191 | 3,108 ms | Nonempty German reply, no tool call |
| Shared workplace in building 1J | 3,116 / 89 | 1,363 ms | One native `anny_search_resources` proposal; the same typed tool runner used by the UI returned eight synthetic resources, with no booking or execution proposal |

The exact requested model ID was returned by HASI for both calls. Temperature 1,
1,536 maximum output tokens and the 45-second profile deadline worked without
an added reasoning parameter. Reported raw provider usage settled both calls;
the existing shared ledger charged 6,464 micro-USD under its conservative
maximum-rate policy. These are measured tokens and admission charges, not a
provider invoice or a general quality/latency benchmark. All model context and
Anny responses were synthetic; no real Anny operation or fallback occurred.

A second isolated container used the exact deployed image, existing database
and signing configuration, no public port, and all provider credential variables
empty. Its profile-readiness response disabled DeepInfra; authenticated model
submission returned only a sanitized HTTP 503 error. Content-free server logs
confirmed `missing_credentials`. No model request was dispatched or budget
reservation added. The first probe harness lost the required Host header and
was correctly denied with 403 before authentication; using an explicit HTTP
Host header exercised the intended missing-key branch. The temporary container
was removed; production credentials were not changed for this negative test.

Before versus immediately after the source deployment, all 227 state rows,
their digest, both budget records and the database container/volume identity
were identical. The subsequent synthetic probes legitimately changed session
state and usage. The ledger advanced to its normal new UTC-day window and
contained two settled calls, 6,679 input tokens, 280 output tokens and 6,464
micro-USD; no manual reset, bootstrap or policy change was performed.

This completes the DI-A1–DI-A4 technical evidence. #81 owns final closure;
M6 model-quality/adversarial comparison and M8 protected-data/real-user
acceptance remain separate.
