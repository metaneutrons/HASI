# Configurable model providers and routing

Date: 2026-10-17. Requested by the operator; acceptance authority for this delivery.
Tracking: [epic #32](https://github.com/metaneutrons/HASI/issues/32),
[R1 #33](https://github.com/metaneutrons/HASI/issues/33),
[R2 #34](https://github.com/metaneutrons/HASI/issues/34).

## Outcome and baseline

Replace the server's fixed model-profile array with a validated, versioned
configuration for standard OpenAI, Anthropic and Groq adapters, GWDG's
OpenAI-compatible service and additional OpenAI-compatible connections.
The pre-delivery baseline had Groq/GWDG credentials, one optional Custom
connection, a fixed selector and no automatic cross-provider fallback. Message
time guarantees already existed and remain acceptance requirements. Registry
and policy delivery is accepted in the linked R1/R2 issues; that acceptance does
not complete institutional data approval or the wider M6 evaluation.

## Configuration and authority

A version-1 JSON document (with JSON Schema for editor completion) defines
connections, profiles, the default profile, explicit user-choice policy and
ordered fallback rules. The server consumes operator-controlled configuration;
no arbitrary provider object, secret reference or endpoint is accepted from a
chat request. An invalid configured document fails closed rather than silently
using a default. The bundled prototype configuration explicitly enables manual
selection and keeps Groq OSS 120B as default, preserving the operator's request.
Other deployments can disable user choice or allow only selected profiles.

Connections select trusted built-in adapters, an HTTPS origin/base path and a
secret reference. Secret values remain environment-managed behind SecretResolver;
only a bounded operator-approved environment reference namespace is accepted.
Standard provider presets supply vendor endpoints; GWDG uses its fixed service
endpoint. Multiple custom connections are supported. No automatic /models
import enables profiles. Native tool capability and synthetic-demo eligibility
are explicit profile declarations, separate from credential readiness and live
qualification. Institutional source/data-policy approval remains out of scope.

The public prototype has mock admin identities. They must not acquire global
configuration or credential-write authority. Configuration is deployed by the
operator; the chat receives only its allowed public profile/policy projection.
A protected configuration editor can later use the same schema after real SSO
and administrative authorization exist. Existing Custom environment variables
remain a documented compatibility input if no explicit document replaces them.

## Routing and failure semantics

Selection is server-enforced on every request. Disabling selection hides/disables
the UI choice and rejects a forged non-default choice; a saved old profile cannot
bypass the new policy. The actual resolved provider/model is displayed. The demo
dialogue mode is separately explicit, not an automatic provider fallback.

Fallback rules specify source profile, ordered target IDs and eligible transient
failure kinds. Empty rules mean no fallback. Cycles, unknown profiles, duplicate
IDs and unbounded chains are rejected. Missing keys/invalid config/auth failures
and invalid business actions do not silently authorize another provider.
Each candidate rechecks full-context synthetic-demo eligibility, required tool
capabilities, readiness and per-generation attempt/output/time limits before any
network request. These are prototype throughput bounds, not durable token/currency
accounting or institutional processing approval.

A successful fallback pins the actual profile for the rest of the current tool
turn via a server-authenticated routing receipt bound to the latest user event,
original choice and current account/workspace. Client claims cannot mint it or
use it to select an otherwise forbidden model. Switching model for a new user
turn follows the configured selection policy. Only failed generation is eligible
for fallback; tool execution and confirmed business actions are never replayed.
Source rights and exact booking confirmation remain enforced independently.

## R1 — Registry and adapter contract

Dependency: merged message-time delivery. Acceptance:

- R1.1: documented v1 configuration and generated JSON Schema cover OpenAI,
  Anthropic, Groq, GWDG and several custom connections with distinct secret refs.
- R1.2: tests reject malformed IDs/origins/refs, credentials in config, duplicate
  IDs, dangling references and cyclic fallback policies. Missing credentials
  disable the connection. No secrets/endpoints/ref names enter the public list.
- R1.3: all four adapter families generate validated native tool calls under
  mocked provider HTTP transports, preserve message times and enforce pinned
  origins, base paths and redirect refusal. Mock protocol evidence is not a
  claim of live OpenAI/Anthropic/custom credentials or model compatibility.
- R1.4: bundled Groq/GWDG behavior, legacy Custom variables and old saved chats
  are compatible. New chats use the operator default (Groq in this deployment).

## R2 — Policy, fallback and deployed workflow

Dependency: R1. Acceptance:

- R2.1: disabled selection and profile allowlists are enforced in UI and server;
  GWDG is manually selectable only when policy permits. Forged profile IDs and
  forged/replayed/cross-account/changed-turn route receipts fail safely.
- R2.2: deterministic tests exercise 429/5xx/timeout fallback, no-match failure,
  missing/forbidden/ineligible candidates, maximum attempts, pinning across a
  tool turn and unchanged proposal/confirmation behavior. No action is replayed.
- R2.3: lint, type checks, backend/web production build and required exact-head
  Node24/26/PostgreSQL CI pass. Independent review checks policy boundaries.
- R2.4: automatic main deployment reaches READY and the custom-domain alias
  resolves to that exact commit; a live Groq chat/tool workflow and manual
  selector/new-chat default are checked at mobile width. No forced live rate
  limit exhaustion or unrequested provider charges are used to test fallbacks.

## Migration, rollout and limits

The registry changes opaque profile IDs from a fixed enum to bounded identifiers;
only the server registry confers eligibility. Existing IDs are retained. Invalid
or removed stored choices are visibly unavailable, not silently rerouted. Route
receipts are short-lived and not persisted as business authority. Old/new browser
compatibility and no-token requests use the operator default/explicit permitted
choice. A rollback restores the prior application/config together; provider-secret
rotation is a separate operation. No database schema migration or container
release is required. No new provider credentials or paid infrastructure are
provisioned by this work.

## DeepInfra follow-up

Requested 2026-10-18, after the synthetic Service-IT integration. This is an
additive provider delivery; the accepted R1/R2 issues stay closed. Use the
existing registry and OpenAI-compatible adapter boundary. The requested model
is `deepseek-ai/DeepSeek-V4.1-Flash`; the operator's dashboard link is a target,
not evidence that this account can invoke it. Credential readiness is unverified.

The [official chat API documentation](https://docs.deepinfra.com/chat/overview)
documents `https://api.deepinfra.com/v1/openai`. Verify the exact model contract,
current tariff and parameters before configuring or making a paid request.

- **DI-A1:** Add a fixed, server-owned DeepInfra connection/profile using
  `env:DEEPINFRA_API_KEY` through the existing secret resolver. Missing credentials
  disable it. Forged origins, secret references and redirects remain rejected.
- **DI-A2:** Verify the exact requested model's native tool-call behavior,
  supported generation parameters, limits and usage accounting. Mock transport
  tests cover errors and malformed tool calls; compatibility is not inferred
  from the API format alone.
- **DI-A3:** Apply an explicitly verified tariff to the existing shared
  USD 1/day admission ledger, preserving prior reservations and consumption.
  Keep Groq as default and GWDG manually selectable; expose DeepInfra only under
  configured user-choice policy. No automatic fallback is enabled by this work.
- **DI-A4:** Qualify a bounded synthetic chat and anny tool round trip on the
  deployed runtime, including a missing-key negative case and sanitized failure
  handling. Record exact code/model/config identities and update operator docs.
  Protected HsH processing approval belongs to final M8 institutional acceptance.
