# Groq context and planning-call budget

Date: 2026-10-18. Status: implementation and local tests complete; exact-head CI,
automatic main deployment and live qualification pending.

## Cause and evidence

At baseline main `75a555b1e624d42337abe22f851a0ce668ec05e0`, a successful
unchecked anny search returned cards but did not stop the four-step model loop.
The next generation received the candidates again and often attempted a sequence
of availability calls. The same occurred for cancellation-related own-booking
lists. The complete system instructions and all six tool schemas were sent on
every call. One provider request could regenerate once after Groq's classified
400 `tool_use_failed`; 429, transport and authentication errors already had no
SDK retry. Thus the old upper bound was four model steps times two upstream
attempts under the bundled policy, not an automatic retry storm on 429.

Groq documents organization-scoped RPM/RPD/TPM/TPD limits. Its published Free
limits currently list 8,000 TPM for GPT-OSS 120B/20B, but this is not evidence of
our account's quota or the exact cause of past 429s. Historic request logs did
not yield usable records during this investigation; prior error handling did
not retain quota counters or dimensions. A successful usage count, the actual
quota headers and an error's dimension are distinct observations.

Official references: [Groq rate limits](https://console.groq.com/docs/rate-limits),
[reasoning controls](https://console.groq.com/docs/reasoning).

## Reproducible payload measurement

Run from the repository root:

```sh
node --conditions=react-server --import tsx apps/web/scripts/measure-chat-context.ts
```

The harness uses fake fetch only, asserts the expected provider endpoint, sends
no network requests and uses a non-secret synthetic placeholder. The exact user
text is `Ich suche einen Arbeitsplatz in Gebäude 1J.` with a verified synthetic
2026-10-18T10:00:00Z time. Seven synthetic workplaces come from the script,
not institutional records. The same input was measured before and after changes;
the new result was reproduced twice. These are UTF-8 bytes, not token estimates.

| Quantity | Baseline | New implementation |
| --- | ---: | ---: |
| First provider request | 13,573 | 9,092 |
| System instructions/calendar | 7,327 | 4,466 |
| Advertised tool schemas | 5,900 (six) | 4,295 (three) |
| Provider request after seven results, if manually invoked | 16,736 | 11,482 |
| Raw result payload retained by the host | 2,443 | 2,443 |
| Provider history after search | 3,110 | 2,464 |

The initial payload is 33.0% smaller. More importantly, the new host does not
make the measured post-search model call at all. This removes a full repeated
prompt and candidate payload. The synthetic search+follow-up baseline total
30,309 bytes becomes one 9,092-byte call (70.0% less request data for that
specific path). This is not a 70% token/cost guarantee for arbitrary chats.

## Behavior and boundaries

- Every successful anny result ends the model batch: search, empty/unchecked
  matches, own-booking lists, availability and proposals. Knowledge retrieval
  can use a second model step to produce a cited answer. The browser has at
  most two steps for ordinary tasks and three for explicit mixed tasks (read/read/
  synthesis). Completed categories are removed from subsequent tool scopes;
  a combined batch synthesizes next with no tools. Each step remains bounded
  by operator attempt policy.
- Standalone office preferences in an existing workplace context and exact
  own-booking list requests use the typed read bridge directly. Compound,
  negated or ambiguous requests remain model tasks. No profile is switched.
- Room/time card selection, proposal preparation and explicit confirmation use
  no extra generation. Availability, permission and proposal checks remain.
- Task scopes reduce advertised schemas for clear room, knowledge or booking
  tasks. Mixed/unclear tasks retain all existing tools; unadvertised output is
  rejected. Scope selection grants no authority and exposes no execution tool.
- Provider-only projection keeps compact details of the two newest anny
  results, relevant exact/alternative intervals and explicit fresh-read flags.
  Older result details are omitted; user text and knowledge evidence are not
  summarized. UI cards and submitted timestamp receipts are not rewritten.
  The pre-existing rolling history limit still removes complete oldest turns;
  an oversized single turn now fails with clarification instead of emptying it.
- Stable instructions precede dynamic user-only calendar anchors. Verified
  Berlin dates survive across midnight/DST; client timestamp claims remain
  untrusted. Prefix stability is not a claim of a measured cache hit.
- Successful and failed profile attempts emit counts and bounded quota metadata
  without prompts, arbitrary headers, IDs or raw error text. Successful usage
  excludes unreported tokens from failed regeneration/fallback attempts. HTTP
  Retry-After uses the provider's sanitized delay; no automatic quota retry,
  provider switch or fallback policy change is introduced.

## Validation

Local lint, types and tests passed. Regression cases cover stopping all anny
result types, direct preference constraints/compound-request counterexamples,
provider-only context projection, receipt/user/knowledge preservation, exact
availability reduction, task-scoped tool rejection, strict quota parsing,
sanitary telemetry on success/failure/fallback, and provider Retry-After.
Existing authorization, ownership, confirmation, provider policy, native adapter
and Berlin midnight/DST tests remain required. CI and live evidence follow in
the implementation PR; this report does not claim a completed deployment yet.

Actual account quota, live token use, inference count and public-domain workflow
must be qualified after deployment. No live anny writes or credentials are needed
for the synthetic workflow. Institutional SSO/data-policy qualification remains
outside this fix; this is not durable token/currency accounting.
