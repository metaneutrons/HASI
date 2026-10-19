# Model provider configuration

Date: 2026-10-19. Version 1. See the [delivery plan](../plans/model-provider-routing.md).

HASI separates connections, model profiles, routing policy and credential values.
Configure an operator-owned JSON document using the
[example](../../config/model-providers.example.json) and
[JSON Schema](../../config/model-providers.schema.json). JSON Schema describes
field shapes; runtime validation additionally checks references, uniqueness,
adapter-specific settings and the bounded acyclic fallback graph.

Validate a document without credentials or network calls:

```sh
pnpm config:models config/model-providers.example.json
```

Set `HASI_LLM_CONFIG` on the web server to the document's JSON contents. For
Coolify, add that server-side runtime variable to the HASI application, then deploy.
It contains configuration and secret references, never secret values. Do not
prefix it with `NEXT_PUBLIC_`. A supplied invalid/empty document fails closed;
it does not fall back to bundled settings. Keep the reviewed document in your
deployment configuration so application/config changes can be reviewed together.
There is no global configuration-write API for the public mock administrator.

## Connections and profiles

Connections select `groq`, `gwdg`, `deepinfra`, `openai`, `anthropic` or `custom`.
Standard providers use fixed vendor HTTPS endpoints. OpenAI defaults to the
Responses API; `api: "chat-completions"` explicitly selects its other protocol.
Anthropic uses its native Messages adapter. GWDG, DeepInfra and custom connections use
OpenAI-compatible Chat Completions. A custom connection requires an HTTPS
`endpoint` without user information, query or fragment. Requests are pinned
to that origin/base path, with redirects refused. No endpoint or credentials
can be supplied in a chat request. Multiple connections can use the same
provider type with separate accounts/secrets.

`credentialRef` accepts `env:GROQ_API_KEY`, `env:GWDG_API_KEY`, `env:DEEPINFRA_API_KEY`,
`env:OPENAI_API_KEY`, `env:ANTHROPIC_API_KEY`, `env:CUSTOM_API_KEY` and
`env:HASI_LLM_SECRET_<NAME>`. Values stay in the deployment secret store.
Missing values disable readiness; the presence of a value proves neither
successful inference nor tool compatibility. Profiles declare connection ID,
exact model ID, tool capability, permitted data classes and bounded parameters.
Use `temperature: null` to omit that parameter for models that reject it.
The current conversational workflow requires native tool support. Example
OpenAI/Anthropic/custom model IDs are placeholders with tools disabled until
the operator configures and qualifies them. No automatic model discovery
enables models, and no additional provider keys are provisioned by this feature.

Without `HASI_LLM_CONFIG`, the bundled prototype policy explicitly enables
manual selection of the Groq/GWDG/DeepInfra profiles and defaults to Groq
GPT-OSS 120B. Valid legacy `CUSTOM_ENDPOINT`/`CUSTOM_MODEL_ID` settings append
`custom-default`; `CUSTOM_API_KEY` independently determines readiness. Explicit
JSON replaces that compatibility configuration instead of merging it silently.

## DeepInfra qualification

The bundled `deepinfra-deepseek-v4.1-flash` profile uses the exact requested
`deepseek-ai/DeepSeek-V4.1-Flash` alias at the fixed
`https://api.deepinfra.com/v1/openai` endpoint. It is Experimental and restricted
to synthetic demo context. Missing `DEEPINFRA_API_KEY` disables readiness;
provision it as a hidden runtime-only Coolify variable from fnox. No credential
is a build argument. Groq remains the fresh-chat default and no fallback is added.

The profile sends temperature 1, a 1,536-token output cap and a 45-second timeout.
No provider-specific reasoning parameter is inferred from other DeepSeek
versions: the model card describes integer effort, whereas the generic API
reasoning guide describes string effort. Reasoning tokens count as output; a
response without usable content/tool arguments fails closed. Native tool/usage
behavior was qualified separately from configuration and mock tests on the
2026-10-19 deployed synthetic greeting/workplace journey; see the
[exact-revision evidence](../verification/2026-10-19/deepinfra.md#deployed-qualification--2026-10-19).
This is bounded technical compatibility evidence, not formal M6 model evaluation
or M8 processing approval.

Prices reviewed on 2026-10-19: standard uncached input USD 0.20 and output USD 0.60
per million tokens. Temporary promotional/cache discounts are not used for
budget admission. The shared ledger still charges the highest approved rates
across providers (USD 0.80/4.00), preserving its existing policy, reservations
and consumption. This is a conservative bound, not invoice accounting.

Sources: [exact model card and tariff](https://deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash),
[chat API](https://deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash/api),
[native tool calls](https://docs.deepinfra.com/chat/tool-calling),
[reasoning billing](https://docs.deepinfra.com/chat/reasoning).

## User choice and fallbacks

`policy.defaultProfileId` controls fresh chats. `policy.userChoice.enabled`
and `profileIds` explicitly permit model selection. With selection disabled,
the UI shows a fixed label and the server rejects another profile, including
saved or forged client choices. Only approved choices/default readiness are
returned publicly; origins and credential references are not exposed. Existing
unavailable saved choices are blocked visibly rather than silently switched.

Fallbacks are empty in the bundled deployment. An operator can add, for example:

```json
{
  "from": "groq-oss-120b",
  "targets": ["groq-oss-20b"],
  "on": ["rate_limit", "server_error", "timeout"]
}
```

Targets must exist in the registry and pass readiness, complete host-context
data policy and tool-capability checks. HTTP 429, HTTP 5xx and explicit timeout
failures are eligible only when listed. Authentication/schema/configuration
errors and missing primary credentials never silently change provider. Sibling
targets are tried in order under the triggering rule; once exhausted, a rule
for the current target may apply. Cycles are invalid. `maxAttempts` bounds
actual generation calls, including Groq's existing native-tool regeneration;
`totalTimeoutMs`, profile deadlines and output caps also apply. Fallback does
not retry tool execution, a proposal submission or a confirmed booking.

A successful fallback returns the actual profile and a short-lived routing
receipt, scoped to the current account/workspace, user event and configuration
revision. The rest of that tool turn stays on the resolved profile. The browser
cannot forge that receipt, transfer it to another task/account, or use it to
enable user choice. A new user turn resets it. The UI identifies actual reply
models and discloses configured fallback labels. Receipts and provider secrets
are omitted from model context and logs.

These are prototype bounds, not durable token/currency accounting. The public
demo host admits only synthetic test conversations and fictional knowledge;
`allowedDataClasses` is an operator policy declaration, not content detection
or institutional approval. Protected HsH context requires trusted provenance,
classification, rights-revocation handling and independent processing approval
for every candidate. Do not treat mock personas as that authorization.

## Qualification and rollback

Tests mock native OpenAI Responses/Chat, Anthropic Messages, Groq and compatible
transports, including negative policy/fallback cases. Groq has live prototype
evidence; GWDG retains its documented Experimental limitations. No live OpenAI,
Anthropic or arbitrary custom endpoint inference is claimed without separately
provisioned credentials and qualification. Model and provider APIs can differ
despite shared protocol shapes.

Restore the application and reviewed configuration together on rollback.
Changing the demo signing secret invalidates old time/routing receipts without
granting any extra rights. No database migration or container publication is
required for this configuration format.

References: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[AI SDK OpenAI](https://ai-sdk.dev/providers/ai-sdk-providers/openai),
[AI SDK Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic),
[compatible endpoints](https://ai-sdk.dev/providers/openai-compatible-providers).
