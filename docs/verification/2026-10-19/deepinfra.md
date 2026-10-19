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

## Remaining deployed gate

DI-A2 and DI-A4 remain open: run a bounded synthetic chat and anny tool round
trip through the exact deployed revision, prove missing-key behavior and
sanitized failures, and retain actual model/config/revision/usage evidence.
No model inference, automatic fallback, production Anny write, protected HsH
processing or budget reset was performed by the offline qualification above.
