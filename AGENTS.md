# HASI project instructions

HASI is a chat-first university assistant. Room search and booking are tools
inside the conversation. Production application components use TypeScript.

Before changing model adapters, routing, provider configuration or credentials,
read [LLM router credentials](docs/architecture/llm-router-credentials.md) and
[security and model evaluation](docs/architecture/security-and-models.md).

- GroqCloud is the first selected model provider. `GROQ_API_KEY` and
  `GWDG_API_KEY` are held in encrypted fnox custody and hidden Coolify runtime
  variables. Vercel has been retired; never use it as the current secret store.
- Keep credentials server-side and separate from model profiles and routing
  configuration. Profiles reference a provider connection; connections reference
  secrets resolved through a HASI-owned abstraction.
- Never put secret values in client bundles, `NEXT_PUBLIC_` variables, prompts,
  plugin payloads, logs, error responses, tracked files or command arguments.
  Do not retrieve secret values merely to inspect configuration.
- Client/model/plugin input cannot choose secret references or provider origins.
  Missing credentials disable the connection; fallback needs explicit approval
  in server policy and eligibility checks for the complete outgoing context.
- Model and provider selection never bypass source access controls, user rights,
  budgets or explicit booking confirmation. Mock personas do not establish
  production authorization.
- Distinguish agreed architecture, configured credentials and verified runtime
  integration. The presence of a key does not prove a working model connection.
