# LLM router credentials

Date: 2026-10-17. Status: agreed architecture with server-side Groq, GWDG SAIA
and optional administrator-configured OpenAI-compatible connections.

GroqCloud is the original provider for the HASI prototype. `GROQ_API_KEY` and
`GWDG_API_KEY` are held in encrypted fnox custody and hidden Coolify runtime
variables after the 2026-10-18 self-hosted cutover. Vercel and Neon are retired.
[The cutover record](../verification/2026-10-18/selfhost-cutover.md) records
bounded successful synthetic inference checks; credential presence and successful
inference remain separate states. Neither establishes protected-data approval,
which belongs to [final institutional M8](../plans/hasi-mvp.md#institutional-acceptance-m8).
The DeepInfra delivery is tracked in #81. Its separate
[deployed synthetic qualification](../verification/2026-10-19/deepinfra.md#deployed-qualification--2026-10-19)
passed on 2026-10-19; configuration/key presence alone does not establish that result.

The [version-1 registry configuration](model-provider-configuration.md) now replaces
the fixed runtime profile array. Standard Groq, GWDG, DeepInfra, OpenAI and Anthropic
connections and multiple custom connections are operator-configurable. User
selection and error-specific fallback rules require explicit policy settings;
the bundled demo enables manual selection and has no fallback rules. The public
mock administrator has no global configuration/credential-write capability.

## Separate providers, model profiles and secrets

The server-side router resolves an approved model profile to a provider
connection. A connection contains an adapter, an approved endpoint, a credential
reference, data-policy constraints and operational limits. A model profile
contains the connection ID, exact model ID, capabilities, parameters and policy
revision. Several model profiles can share a provider connection and credential.
Separate provider accounts or projects use separate connection IDs and references.

Credential values are stored in the deployment's secret store. The repository,
configuration database, model profiles and routing rules contain references only.
The first implementation uses environment-variable references behind a
HASI-owned `SecretResolver`; a later institution-operated secret manager can
replace that resolver without changing model profiles or the chat interface.

| Connection example | Credential reference | State |
| --- | --- | --- |
| GroqCloud demo | `env:GROQ_API_KEY` | First selected provider; provisioned by operator |
| GWDG SAIA demo | `env:GWDG_API_KEY` | Optional selectable connection; key is provisioned by operator |
| DeepInfra demo | `env:DEEPINFRA_API_KEY` | Experimental synthetic-only profile; runtime qualification tracked in #81 |
| Custom OpenAI-compatible | `env:CUSTOM_API_KEY` | Optional; requires valid server-side endpoint, model ID and key |
| OpenAI | `env:OPENAI_API_KEY` | Naming example; not configured or approved |
| Anthropic | `env:ANTHROPIC_API_KEY` | Naming example; not configured or approved |
| Mistral | `env:MISTRAL_API_KEY` | Naming example; not configured or approved |

An illustrative server-owned connection is:

```ts
{
  id: "groq-demo",
  adapter: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  credentialRef: "env:GROQ_API_KEY",
}
```

The bundled GWDG connection is fixed to its SAIA endpoint and has one selectable profile.
The custom connection uses `CUSTOM_ENDPOINT` and `CUSTOM_MODEL_ID` supplied by
the operator in the server environment; it is shown only when the HTTPS
endpoint and model ID validate. Its key is resolved through the same allowlisted
secret resolver. Additional declared connections can reference `env:OPENAI_API_KEY`,
`env:ANTHROPIC_API_KEY` or `env:HASI_LLM_SECRET_<NAME>`; client input cannot
select these references. No custom connection values are accepted from a chat request.
The bundled configuration includes Groq GPT-OSS 120B, 20B and Qwen3.8 27B Preview, the GWDG
`qwen3-30b-a3b-instruct-2507` profile, DeepInfra `deepseek-ai/DeepSeek-V4.1-Flash`,
and the optional legacy custom profile. Other profiles are declared in the validated operator document, not enabled by client input. The GWDG
GPT-OSS 120B profile is deferred after protected Preview probes returned
upstream HTTP 500; its cause is not established. Qwen passed Preview checks for
knowledge retrieval and anny room search on 2026-10-16. Production greeting
generation also passed, but a knowledge question omitted retrieval and invented
a citation identifier. The profile is labelled Experimental; see the
[dated evaluation observations](../evaluation/gwdg-preview-2026-10-16.md).
These checks do not establish reliable source grounding or approval for protected HsH data.
Configured custom providers must be independently qualified for native tool
calls before room workflows are enabled. Production data-policy approval and
deployment qualification of the shared budget remain required. The candidate
budget implementation and the explicitly approved temporary GWDG price estimate
are documented in [the budget policy](model-budget.md). HASI's router
is a server-side application module; introducing an external routing service
would require a separate trust and credential-storage decision.

## Resolution and exposure rules

1. Authenticate or explicitly admit the request under the public demo policy.
   Resolve the user's allowed profile and validate the complete outgoing context,
   provider eligibility, capabilities and budget before a provider call.
2. Resolve `credentialRef` from the validated, server-owned connection. Client
   input, model output, documents and plugins cannot choose a secret name or
   override a provider endpoint. Custom endpoint and model settings come only
   from server environment configuration and are validated before use. Do not
   perform arbitrary `process.env` lookups from request parameters. A missing
   credential makes its profile unavailable.
3. The trusted provider adapter uses the resolved credential only for requests
   to its approved destination. Reject redirects that could forward credentials
   to another destination. Never send provider credentials to integration plugins.
4. Credentials, authorization headers and secret-store responses must not enter
   prompts, tool arguments, chat history, logs, traces, error bodies or browser
   bundles. Do not prefix credential variables with `NEXT_PUBLIC_`. Provide
   sanitized errors and explicit telemetry redaction; do not rely on build-log
   redaction to protect runtime output.
5. The administration UI exposes connection/model configuration, readiness,
   credential-reference names and sanitized check results. It never returns an
   existing secret value, suffix or credential-derived fingerprint. For the
   prototype, operators enter secrets through fnox hidden input and provision
   hidden Coolify runtime variables; public mock HASI forms cannot write them.
6. Model switching changes the selected profile, not the user's authority or
   credential permissions. A missing/revoked key must not trigger an unapproved
   provider fallback. Approved fallbacks recheck context eligibility and budgets.

## Deployment and rotation

Store workstation copies with `fnox set NAME -g -p age` using hidden input,
then provision only the intended hidden Coolify runtime variables through a
trusted operator process. Never pass values in arguments, build inputs or chat.
Use `fnox exec -- <trusted command>` to supply credentials to an authorized
process without displaying them. `GROQ_API_KEY` and `GWDG_API_KEY` are current;
`DEEPINFRA_API_KEY` is the DeepInfra reference; encrypted custody presence was
confirmed on 2026-10-19, with separate deployed synthetic qualification evidence above. Do not enable a connection merely because a variable exists.

Use distinct production and test keys when institutional integrations are
provisioned. Keep separate provider accounts/projects and data-policy approvals.
See [the self-hosted Compose runtime](../../deploy/coolify/compose.hasi.yml) and
[cutover evidence](../verification/2026-10-18/selfhost-cutover.md). Local development
uses an injected process environment or an ignored environment file;
`.env.example` contains placeholders only. Do not retrieve values merely to
inspect configuration. There is no current Vercel credential workflow.

Environment changes apply to new deployments. Routine rotation provisions a new
provider key, updates the secret, deploys and verifies it, then revokes the old
key and retires deployments that still depend on it. Revoke a compromised key
immediately. Rotate `GWDG_API_KEY` at least every six months. Audit records contain connection ID, environment, operation, actor
and time, never credential values. A rollback must account for revoked keys.

The public self-hosted prototype uses separate Traefik inference and timestamp
request buckets, per-call input/output limits and a bounded tool loop. Vercel WAF
is inactive outside Vercel. The durable cross-instance USD 1/day ledger is
initialized and was preserved through the local PostgreSQL cutover; see
[the migration record](../verification/2026-10-18/local-postgres-cutover.md).
Estimated prices and conservative reservations are not provider invoice
accounting. Provider-side spending quotas remain required for the institutional
pilot. See [public deployment limits](public-demo.md) and
[budget provisioning](model-budget.md). Selectable mock personas are not trusted
identities for privileged configuration or budgets. Plugin booking confirmation
remains outside model authority.

## Implementation verification

Verify missing/revoked credentials, client attempts to override references or
endpoints, logging/error redaction, environment isolation, model switching,
disallowed fallback, rate/budget exhaustion and rotation. Tests use fake secrets
and provider mocks; live checks must never print a credential. An administrator's
readiness result distinguishes configured, verified, unavailable and failed.

See [security and model evaluation](security-and-models.md) for context eligibility
and prompt-injection boundaries. Provider and platform references:
[Groq quickstart](https://console.groq.com/docs/quickstart),
[Groq API compatibility](https://console.groq.com/docs/openai),
[GWDG SAIA and custom provider integration](gwdg-saia.md), and
[Vercel Config and Secret variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables).
