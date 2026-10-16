# GWDG SAIA and custom model connections

HASI's public demo currently permits synthetic test data only. Selecting GWDG
SAIA or a custom endpoint does not constitute institutional approval for
protected HsH information. The model profile API reports whether the required
server-side settings are present; it does not perform a live connection or tool
compatibility check.

## GWDG SAIA

The server-owned `gwdg-demo` connection uses
`https://chat-ai.academiccloud.de/v1` and resolves `env:GWDG_API_KEY` only from
the web server environment. The initial profile allowlist is deliberately
limited to:

| Profile | SAIA model ID | Tool calling |
| --- | --- | --- |
| GWDG SAIA · Qwen3 30B A3B Instruct 2507 | `qwen3-30b-a3b-instruct-2507` | Listed as verified by GWDG |

HASI currently exposes only the Qwen profile. A protected Preview check on
2026-10-16 passed short text generation, a `knowledge_search` tool call with a
cited answer, and an `anny_search_resources` room search. Initial GPT-OSS 120B
probes returned upstream HTTP 500, including a short text request, so HASI
defers that model despite GWDG listing it as tool-calling verified. The upstream
cause is not established; add the profile only after successful runtime
qualification.

The profile is labelled **Experimental**. A subsequent Production browser test
answered a knowledge question without invoking `knowledge_search` and invented
a citation identifier. Passing individual native-tool cases does not establish
reliable tool selection or source grounding. Only validated retrieval results
produce trusted source cards. See the [dated evaluation observations](../evaluation/gwdg-preview-2026-10-16.md).

The adapter calls the OpenAI-compatible Chat Completions API through AI SDK's
OpenAI-compatible provider and uses the same HASI tool schemas and reply
validation as Groq. It adds no GWDG-specific options, retries or automatic
fallback. GWDG's published model list changes over time; new model profiles
require an explicit code and evaluation change.

Generation deadlines are 45 seconds for GWDG and 20 seconds for Groq and custom
connections. The server route's invocation limit must exceed the selected
provider's deadline.

To add the key to a new Vercel deployment, use interactive secret entry. Do not
put the value in the command, shell history, repository or client environment:

```sh
vercel env add GWDG_API_KEY production,preview \
  --type secret \
  --project hasi \
  --scope metaneutrons
```

Local development can provide `GWDG_API_KEY` in the ignored
`apps/web/.env.local`. Changes to Vercel environment variables apply to new
deployments. Rotate the GWDG key at least every six months: provision the new
secret, deploy and verify a new Preview and Production deployment, then revoke
the former key. Revoke a compromised key immediately. Never retrieve the key
value merely to check whether it exists.

## Custom OpenAI-compatible connection

An operator can configure one optional `custom-default` profile using these
server-only variables:

```dotenv
CUSTOM_API_KEY=
CUSTOM_ENDPOINT=https://provider.example/v1
CUSTOM_MODEL_ID=provider-model-id
```

The profile appears only when the endpoint and model ID are valid. Its
`configured` status also requires a non-empty `CUSTOM_API_KEY`; a missing key
disables that profile without affecting readiness for Groq or GWDG. Endpoint
and model settings are snapshotted from the server environment for each call.
The endpoint must be HTTPS and contain no user information, query or fragment.
HASI strips trailing slashes, pins requests to the configured host and base
path, and rejects redirects. It never accepts the endpoint, model ID, credential
reference or secret name from a client or model request.

The model ID is trimmed, limited to 128 characters and rejected if it contains
control characters. The endpoint must implement OpenAI-compatible Chat
Completions and native tool calls. Operators must qualify both knowledge and
anny tool-call behavior against their chosen provider before enabling room
workflows. HASI validates every returned tool name and argument and never turns
free-form prose into an action. Custom calls use no Groq options or retry and
never switch to another provider when configuration or inference fails.

Keep all three values in the web server environment or an ignored
`apps/web/.env.local`; never use a `NEXT_PUBLIC_` prefix. Store
`CUSTOM_API_KEY` as a Vercel Secret and configure the endpoint and model ID as
server-side environment variables. The browser receives the profile ID,
display label, model ID, provider type and a boolean configuration status, never
the endpoint or credential metadata.

## Official references

- [GWDG SAIA API, endpoint and model names](https://docs.hpc.gwdg.de/services/ai-services/saia/index.html)
- [GWDG Chat AI model catalogue](https://docs.hpc.gwdg.de/services/ai-services/chat-ai/models/index.html)
- [GWDG verified tool-calling models](https://docs.hpc.gwdg.de/services/ai-services/jupyter-ai/index.html)
- [AI SDK OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers)
- [Vercel sensitive environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
