# Shared model-call budget

Status: implementation in progress, 2026-10-18. Runtime admission is not yet
deployment-qualified. This document does not establish provider billing limits.

Fabian approved a total **USD 1 per UTC day** for the demo. One durable ledger
is shared across users, workspaces, deployments using the same database,
providers, retries and fallbacks. Input and output limits are 1,250,000 and
250,000 tokens per day, in addition to the currency admission ceiling.

## Temporary GWDG pricing decision — follow-up required

On 2026-10-18 Fabian explicitly authorized using Groq prices for GWDG until
its actual tariff is available. The configured GWDG Qwen3 30B A3B profile uses
the Groq Qwen3.8 27B rates: **USD 0.80 per million input tokens and USD 4.00 per
million output tokens**. This is an **operator-approved estimate**, not a
published GWDG tariff. Replace it with the contractual SAIA price and migrate
the active ledger policy without clearing consumed usage. The resulting USD 1
limit is a limit under the approved estimate, not a guarantee about the GWDG
invoice. API token counts do not supply the missing contractual price.

Other reviewed Groq rates are GPT-OSS 120B at USD 0.15/0.60 and GPT-OSS 20B at
USD 0.075/0.30 per million input/output tokens. Sources:
[GPT-OSS 120B](https://console.groq.com/docs/model/openai/gpt-oss-120b),
[Groq models](https://console.groq.com/docs/models),
[Qwen3.8 27B](https://console.groq.com/docs/model/qwen/qwen3.8-27b).
No cached-input discount is assumed.

Anthropic Message responses report uncached `input_tokens` separately from
`cache_creation_input_tokens` and `cache_read_input_tokens`; the router sums all
three for reported input usage and budget-bound validation. Anthropic's
[pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing)
defines total input as that sum and prices cache writes above base input rates.
If an Anthropic profile is enabled with an operator-supplied `HASI_MODEL_PRICES`
entry, its `inputMicroUsdPerMillion` must cover the highest applicable cache
write tariff for that exact model and request configuration (including any
applicable pricing modifiers). The ledger charges all counted input at that
single conservative rate; it does not model cache discounts or write tiers.
Anthropic has no bundled price, so an unpriced profile remains denied.

The current ledger conservatively charges the maximum approved input/output
rates across models. It is an admission bound rather than exact invoice
accounting. Reported token usage remains distinct from calculated admission
cost. Exact per-provider cost reporting can be added without weakening the
shared reservation boundary.

## Admission and failure behavior

Every actual provider attempt reserves serialized UTF-8 context/tool-schema
bytes plus a fixed protocol allowance as an input bound and the configured
maximum output. This assumes the qualified provider's tokenization/protocol
overhead stays inside those bounds; it is not a provider-side spending quota.
The router disables SDK retries and explicitly reserves each retry/fallback.
Unknown usage or a lost response retains the full reservation. Explicit raw
provider counts may reconcile it downward. Missing, malformed or out-of-bound
successful usage stops further attempts and requires investigation.

The v1 ledger retains at most 512 unresolved prior-window reservation IDs for
late reconciliation. On rollover, older unresolved reservations are removed
from the ID list and added to the cumulative `archivedUnknown` snapshot totals
at their full reserved token and estimated-cost bounds. Those archived totals
remain visible but do not count against a later UTC day's admission limit; an
archived reservation can no longer be reconciled individually. The archive
preserves uncertainty without allowing unresolved IDs to grow without bound.

CAS updates serialize admissions across processes. Storage errors, missing
deployed state, policy mismatches and unknown prices deny new model calls.
Existing room cards and confirmed actions do not need another model generation.
No request may choose a price, budget scope, secret or database namespace.

The explicit live `pnpm probe:groq-cache` command also requires an existing
PostgreSQL ledger, even in development. Both HASI and plain-control modes reserve
each actual HTTP request through that shared ledger. HASI mode uses the router's
per-attempt admission, including repair attempts; plain controls reserve in the
HTTP transport because they have no router. No request is charged by both layers.
Production router calls without admission are rejected before provider I/O.
The probe validates that
its fixed Groq model matches the operator-approved budget profile; missing,
invalid or out-of-bound usage retains the full hold. Offline context measurement
continues to use a synthetic fetch implementation and makes no provider calls.

`HASI_MODEL_PRICES` is an optional operator-only JSON array replacing the bundled
tariffs. Entries bind provider, exact base URL and model ID to positive integer
input/output micro-USD rates per million tokens and a `published` or
`operator_estimate` basis. New endpoints/models have no implicit tariff.

## Deployment bootstrap

Budget data uses the non-expiring database namespace
`model-budgets:shared:v1`, independent of Vercel commit and workspace namespaces.
Every deployment using credentials covered by the approved USD 1 ceiling must
point at the same physical budget store, including Preview and Production if
they share the provider account. Matching namespace names in separate database
branches do not share a limit. The current adapter uses `DATABASE_URL`;
verification of the actual deployment bindings and cross-environment concurrent
admission remains a deployment gate. Do not infer that guarantee from an
integration-resource name or disclose connection strings to check it.
The operator explicitly provisions the record before deploying budget-enforced
chat, using the existing database credential injected into the process:

```sh
node --conditions=react-server --import tsx \
  apps/web/scripts/initialize-model-budget.ts --initialize
```

The command preserves an existing ledger and prints aggregates only. Model
requests never initialize missing deployed state. Losing the record requires
operator reconciliation/restoration; creating a new deployment cannot reset it.
Local development without a database uses a process-local ledger and does not
qualify durable budget enforcement. Price/policy changes deliberately conflict
with existing state until an audited migration preserves that day's charges.

For a deployment-only bootstrap without downloading managed credentials, an
operator may supply `HASI_INITIALIZE_MODEL_BUDGET=1` as a **one-off build
environment override** to a reviewed Vercel deployment. The build then runs
the same explicit initializer with Vercel-managed database credentials inside
the build process. Do not persist the override as a project variable: ordinary
rebuilds/restarts must not recreate deleted budget state. Builds without the
override skip initialization and do not query the database.

To qualify a shared Preview/Production binding without downloading credentials,
add the same fresh UUID as one-off `HASI_MODEL_BUDGET_VERIFY_RUN` alongside the
initializer override. Build Preview first and a Production deployment with
domain promotion disabled second. Preview writes a one-hour verification marker;
Production must observe it in the shared namespace before it can initialize the
ledger. Both emit the same database destination identifier, derived only from
host/port/database and excluding credentials and query options. A missing marker
or different destination fails the operator build. Database routing/search-path
overrides in URL query parameters are rejected. The generic state table may be
created during connection initialization; a failed binding check does not create
or reset the budget ledger record. This verifies the two tested
deployment bindings, not arbitrary future branches, cloned stores or historical
deployments that predate budget enforcement. Ordinary builds use neither flag.
