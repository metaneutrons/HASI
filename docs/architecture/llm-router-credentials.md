# LLM router credentials

Date: 2026-10-16. Status: agreed architecture with a first server-side Groq adapter.

GroqCloud is the first provider for the HASI prototype. Fabian has confirmed
that `GROQ_API_KEY` was added to the Vercel project `hasi`, team `metaneutrons`,
for Production and Preview; metadata checks confirm the Secret in both scopes.
The prototype now has a server-side router using AI SDK Core and Groq provider
adapters. Credential presence and successful inference are separate states;
neither approves GroqCloud for protected HsH information.

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

The first router implements this connection internally and allowlists GPT-OSS
120B, 20B and the explicitly selected Qwen3.8 27B Preview comparison profile. Production data-policy approval and durable budgets remain
required. HASI's router
is a server-side application module; introducing an external routing service
would require a separate trust and credential-storage decision.

## Resolution and exposure rules

1. Authenticate or explicitly admit the request under the public demo policy.
   Resolve the user's allowed profile and validate the complete outgoing context,
   provider eligibility, capabilities and budget before a provider call.
2. Resolve `credentialRef` from the validated, server-owned connection. Client
   input, model output, documents and plugins cannot choose a secret name or
   override a provider endpoint. Do not perform arbitrary `process.env` lookups
   from request parameters. A missing credential makes the connection unavailable.
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
   prototype, operators enter and rotate secrets through Vercel, not HASI forms.
6. Model switching changes the selected profile, not the user's authority or
   credential permissions. A missing/revoked key must not trigger an unapproved
   provider fallback. Approved fallbacks recheck context eligibility and budgets.

## Deployment and rotation

Store Vercel credentials as **Secret** variables scoped to the required
environments. Provision future providers explicitly; do not discover or enable
providers merely because a variable happens to be present. Use separate provider
keys/projects for institutional production and test environments. The initial
public prototype may use the provisioned demo credential in both scopes.

The established CLI workflow, with interactive secret entry, is:

```sh
vercel env add GROQ_API_KEY production,preview \
  --type secret \
  --project hasi \
  --scope metaneutrons
```

Keep secret values out of command arguments and shell history. Local development
uses an ignored environment file in the executing server application's directory
or an injected process environment; `.env.example` contains placeholders only.
Do not pull deployment secrets to a workstation merely to check configuration.
Document each executing service's environment loader when implementing the router.

Environment changes apply to new deployments. Routine rotation provisions a new
provider key, updates the secret, deploys and verifies it, then revokes the old
key and retires deployments that still depend on it. Revoke a compromised key
immediately. Audit records contain connection ID, environment, operation, actor
and time, never credential values. A rollback must account for revoked keys.

The public prototype enforces shared regional Vercel WAF request limits,
per-call input/output limits and a bounded client tool loop. These bound
throughput but are not exact cross-region token/currency accounting. Durable
budget reservations and provider-side spending quotas remain required for the
institutional pilot. See [public deployment limits](public-demo.md). Selectable mock personas are not trusted
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
[Groq API compatibility](https://console.groq.com/docs/openai), and
[Vercel Config and Secret variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables).
