# Zammad ticket-creation MCP

Date: 2026-10-16. Status: proposed future roadmap. No Zammad MCP, connector,
credentials, category mapping or production queues are implemented or configured.

## Scope and boundary

Zammad is a possible later support integration for creating tickets from chat.
It supplements the mandatory MVP integrations for Intranet, Service-IT and anny;
it does not defer or replace them. The MVP scope and sequence remain in the
[pilot plan](../plans/hasi-mvp.md).

The proposed independently deployed MCP plug-in follows the existing
[plugin contract](plugins-and-prototype.md): version-pinned tools, validated
schemas, short-lived signed actor context and server-held proposals. It has
three stages:

| Stage | Proposed behavior |
| --- | --- |
| Read | Return a minimal status or receipt only for a ticket linked server-side to the authenticated requester. No arbitrary ticket search, group listing or article-history read. Recheck requester and topic permissions on every read. |
| Prepare | Accept an approved topic key, the topic's configured required fields and a draft title/body. Resolve the requester, destination and allowed fields from server policy; create an expiring proposal without contacting the create endpoint. |
| Execute | After a separate authenticated confirmation, recheck access and configuration, then create the ticket using the immutable proposal. This is not a model-callable execution tool. |

Generalize the existing signed proposal and confirmation path before wiring a
Zammad write into the core. The current prepare path still expects
room-specific fields such as `draft.resourceName`, `draft.startDate` and
`draft.endDate`; it cannot represent a ticket proposal as-is. The generalized
contract and confirmation UI must support typed action-specific previews and
bind the actor, plug-in/tool, exact validated payload, destination/config
revision, expiry and execution state. Preserve the booking flow's current
authorization and exact-confirmation guarantees while making this change.
This is prerequisite implementation work, not a capability provided by this
roadmap document.

## Admin-configurable taxonomy and routing

The taxonomy and routing table are server-owned, versioned administrator
configuration. They are not a code enum: administrators can add or retire a
security domain, topic, display label or Zammad Group destination without a
plug-in code redeploy. Each domain defines its security/data classification
and its integration connection. Each topic has a stable topic key, an approved
user-facing label, an optional hierarchy, eligibility rules, required fields,
and routing predicates over validated fields such as location. A resolved
route selects a configured integration connection and destination Zammad
Group (the queue); the group ID and connection reference remain private to the
server. Example domains such as IT support or personnel services are
illustrative only, not fixed product categories.

The model receives only the filtered catalogue of topics that the authenticated
user may submit. The tool accepts a general string topic key and the configured
field values, then validates them against the active server configuration; it
does not bake a fixed topic enum into code or the MCP schema. Each configured
input field has a stable key, an explicit type and constraints, and an
administrator-approved mapping to a supported Zammad ticket attribute or
configured custom field. Reject unknown fields, unsupported types and values
that do not match the mapped field. Never pass arbitrary model-provided keys
through as Zammad API fields. The model cannot submit a group ID/name, customer
ID, role, credential reference, API origin, article type or visibility flag.
It cannot change routing predicates or select a connection. The application
resolves destination and allowed fields from configuration and current identity
policy.

Before activation, configuration changes must pass server-side validation and
a preview/dry-run against the target Zammad instance. Validate that the
destination Group exists and is active, the selected connection is approved
for the domain, and either its effective permissions are confined to that
domain or an independent, non-bypassable authorization boundary provides the
same isolation. Also validate that required fields and routing predicates are
satisfiable and that rules produce a single destination for each valid input.
Record the administrator, time, revision and validation result in an audit
trail. A config revision change invalidates pending proposals and requires a
fresh preview and confirmation. Do not discover groups during model calls or
take group values from user or model input.

An unavailable, unauthorized, unmapped or ambiguous topic/route fails closed.
Ask the user to clarify among categories they may use, or stop with a safe
handoff. Never apply an implicit default or cross-domain fallback. Show users
only approved labels and their own ticket receipts. Do not expose group IDs,
rosters, restricted topic labels or other domains' queue metadata to users who
are not authorized for that information.

## Security-domain isolation

Treat each administrator-defined domain as a distinct security boundary,
whether the domains represent different support functions, personnel matters
or another sensitive workflow. Prefer separate integration connections and
least-privilege credentials, with separate plug-in instances where needed. A
shared connection or plug-in process is acceptable only if an independently
verified, non-bypassable authorization boundary enforces domain isolation;
shared credentials alone are never that boundary. Never use an admin
credential for ticket creation.

Zammad's API documents access tokens with a permission list and describes
`ticket.agent` access as based on Group Access. Ticket endpoints also depend
on group permissions. The documentation does not establish that a token can
be restricted to an arbitrary group by the token value alone. Effective
isolation is therefore a deployment acceptance condition: verify each
connection's actual account, role/group access and token against the target
instance. Test every configured pair of domains for denied cross-domain reads
and creates, using a sensitive domain such as personnel/HR as one illustrative
case. Test the boundary that is meant to provide isolation: direct Zammad API
attempts for domain-scoped credentials, and gateway bypass plus forged-domain
requests when isolation is enforced by a gateway. If no boundary can pass
these tests, do not enable the shared integration; use isolated Zammad
instances or an independently verified authorization gateway. [Zammad access-token and permission documentation](https://docs.zammad.org/en/latest/api/user-access-token.html)

HASI authorization and Zammad group access are separate checks. A user's
right to submit a topic in HASI does not grant the integration credential
access to a queue, and a powerful API account does not grant that user access
through HASI. Enforce both on every read, prepare and execute path. Mock
personas and model assertions never establish institutional authorization.

## Identity and ticket content

Resolve the requester from the authenticated HsH SSO session, namespaced by
issuer and stable subject, then map it server-side to the corresponding
Zammad customer. Never accept identity, customer ID or email address from
model output as authority. Missing, stale, duplicate or ambiguous mappings
stop ticket creation; do not create a new Zammad user as a fallback.

Zammad documents `POST /api/v1/tickets` with `title`, `group`, `customer` and
an `article` object. Creating on behalf of another user with `customer_id`
requires `ticket.agent`; without that permission the API ignores
`customer_id` and assigns the ticket to the authenticated API user. When
creating on behalf of a customer, set `article.sender` explicitly to
`Customer`. The adapter must verify the returned ticket is associated with
the mapped requester before reporting success. All values for the API's
`group` field come from the server-owned allowlist, never from model input.
[Zammad ticket API](https://docs.zammad.org/en/latest/api/ticket/index.html)

Minimize content to the user's exact title and body, approved topic and
server-mapped requester. Do not attach the full conversation, profile data,
source documents or chat history by default. Attachments are out of the first
planned slice; adding them requires an approved data policy, explicit user
selection, file validation and a preview of every attachment.

For a customer-submitted request, the planned initial article is a plain
`note` with `sender: Customer` and `internal: false`, subject to verification
in a sandbox before implementation. Zammad uses `internal` for article
visibility to customers; it is separate from agent group access. An internal
article may still send email when its type is email, so `internal` is not a
notification or queue-access control. The model cannot set the article type,
sender, recipients or `internal` flag. Verify customer and agent views and
notification behavior against the actual instance before enabling creation.
[Zammad ticket article documentation](https://docs.zammad.org/en/latest/api/ticket/articles.html)

## Model and privacy policy

Treat ticket text, attachments and tool results as untrusted data. None may
change identity, topic authorization, group mapping, confirmation state or
credentials. Validate all fields and downstream effects in the backend.
Request only the context needed for the user's support task and avoid storing
ticket bodies in general-purpose logs or telemetry.

For any domain whose classification requires additional approval, including
personnel/HR or other restricted personal data, check the full outgoing
context before every model call. This includes conversation history,
summaries, attachments and tool results. Such context may reach only a model
profile explicitly approved for the relevant data classification. Groq is not
approved for HR or other restricted content by default; there is no automatic
fallback to another provider. If no eligible profile is available, do not
send the context to a model; the user may enter and review their own text
through a constrained form. Apply the same eligibility rules to summarizers,
classifiers, rerankers and any other processor, consistent with
[security and model evaluation](security-and-models.md).

## Proposal, confirmation and retry behavior

Before confirmation, show the exact topic and recipient queue using an
approved user-facing label, plus the title, body, selected attachments and
verified requester identity. Display that label instead of a restricted
internal group name. Bind
the expiring proposal to the actor, tenant, plugin version, exact content,
topic, resolved connection/group configuration revision and attachment
hashes. Recheck identity, category permission and the configuration revision
at execution. Any change to the topic or content invalidates the proposal and
requires a new preview and confirmation.

Give each logical submission a server-generated idempotency key and persist
its state. Do not assume that Zammad's ticket-create endpoint deduplicates
requests; the documented API describes `POST` but does not promise an
idempotency contract. After a timeout or lost response, reconcile the outcome
using a target-instance mechanism verified before deployment, such as a
supported unique integration marker. If reconciliation cannot establish
whether the ticket exists, keep the submission indeterminate and require
manual resolution. Never blindly resend a create request.

## Acceptance gates and open decisions

Before implementation, confirm the real Zammad instance or instances,
administrator-defined security domains and topic catalogue, group IDs and
owners, approved labels, eligibility rules, data classifications, required
fields and routing predicates. Establish and test the SSO-to-Zammad customer
mapping and each domain's API account/permission design. In particular,
verify pairwise that a domain-scoped credential cannot read or create tickets
in another domain, or that the independent authorization boundary blocks the
same operations and cannot be bypassed. Token permission names alone are not
evidence of that boundary.

The planned acceptance suite must demonstrate that:

- an administrator can add a third arbitrary security domain, topic and Group
  destination through configuration only, without rebuilding the plug-in or
  core, and the filtered topic catalogue reflects the authorized change;
- duplicate keys within their domain/topic/field namespaces, invalid
  connection/group/field mappings, unsupported field types and overlapping
  routing predicates that could resolve one request to multiple destinations
  are rejected before activation;
- forged identity, model-supplied customer/group IDs, unauthorized categories
  and prompt-injected route changes are rejected;
- groups, their names and ticket contents from one security domain do not
  appear in another domain's tools or to users without authorization; HR may
  serve as an illustrative sensitive-domain case;
- missing or ambiguous routes never fall back to a default or cross-domain
  queue, and require clarification or a safe handoff;
- ticket previews match the submitted requester, destination, title, body and
  attachments; topic/content edits invalidate prior confirmations;
- customer-visible article behavior, group-level agent access and outbound
  notifications match the approved sandbox behavior;
- retries, duplicate confirmations and lost responses cannot create duplicate
  tickets; uncertain outcomes enter reconciliation;
- no restricted-domain context, including HR context, reaches Groq without
  explicit institutional approval or any profile that is ineligible for the
  full conversation, including through fallback or auxiliary model calls.

These criteria are planned and untested. No Zammad queues, group IDs, API
credentials or connector are configured by this document.
