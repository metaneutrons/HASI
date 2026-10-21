# Protected workplace-planning route and Anny bridge

Base: `ea79670ed42fe6f206068e9e74bc3c397f7a2f01` (PR #202).
This is deterministic technical development evidence for [M6 #53](https://github.com/metaneutrons/HASI/issues/53),
not actual-model, human-quality or complete initial-chat acceptance.

## Composition

The code-owned room fixture composes the actual loopback TestIdP/OIDC account,
verified minimal host actor, per-installation account consent/projection,
registry, signed MCP and Anny reference contract. Its API now uses development
composition to expose `synthetic_demo` model eligibility; OIDC, TestIdP and the
account service retain their test-only authorities. The host actor contains
neither global Anny customer nor resource IDs. The new web-only scope/signing
material is randomly generated fixture data, never a deployment credential.
Core and source requests use Fastify injection rather than external HTTP.

The web test invokes the actual timestamp POST and `createChatPostHandler`,
with the protected-local configuration guard intact, fixed loopback origins,
an unused loopback `hasi_topology_test` database sentinel, fake admission and a
strictly intercepted fake Groq transport. Only the code-owned core session,
history-authority and tool-list paths may pass through the route interceptor.
The actual `createAnnyChatTools` bridge uses a fixed authenticated fixture
transport for its existing resource, availability and proposal paths.
No real database, model provider or production budget is opened.

## Observed flow and controls

The focused two-file run passes **five tests**. The new happy-path case:

- stamps a complete, future Berlin-calendar 1J workplace request through the
  actual timestamp route; the real server clock is not frozen;
- calls the protected chat route and observes an authorized, forced
  `anny_search_resources` tool choice, one validated returned call, one fake
  provider request and one settled fake reservation (31 input / 9 output tokens);
- executes that returned call through the actual bridge and receives exactly
  the two permitted fixture workplaces;
- composes the actual standalone `officePreferenceSearch` helper for `mir egal`
  and its direct bridge search, preserving the original interval;
- scripts a user selection from the actually returned permitted resources,
  checks availability, rechecks the selected interval, and prepares one
  server-bound **pending** proposal for the original owner/resource/service/time;
- observes three contract availability GETs (selection, explicit recheck and
  independent preparation check), zero confirmation requests, zero source write
  attempts/effects and still only one fake provider request.

The bridge rejects an unreturned resource before an upstream availability read.
The separate negative case denies an invalid session (401), wrong Host (403), cross-origin request (403)
and a changing current history authority (409) before provider dispatch. The
receipt control first reuses an unchanged valid same-scope timestamp exactly,
then changes the local scope and observes replacement of the old receipt.
Environment and global fetch are restored in `finally`, and owned fixtures close.
Existing fixture tests retain malformed/foreign destination and write-effect
controls. PR #201 separately qualifies both actual backend convenience-route
foreign/revoked denials and the original API counterprobe; the bridge's
unreturned-resource rejection is not substituted for that server evidence.

Scoped root/web type checks and strict ESLint in the respective workspaces pass.
Independent read-only review found no remaining actionable issue after adding
the distinct wrong-Origin countercase. Its scope clarification is retained:
foreign-scope re-stamping qualifies the timestamp endpoint, not chat consumption
of that old receipt. Full integration CI and deployed delivery are tracked in
the implementation PR, separately from this focused local result.

## Limits

This test manually composes the production route, bridge and shared helper.
It does **not** mount `AssistantPage`, exercise its private send/choose/prepare
closures or render/click cards. The absence of a second model call here is an
observation of this composed helper flow, not proof that a future UI regression
cannot call inference again. A complementary actual-component/browser journey
and actual per-profile initial-planning/calendar/dialogue observations remain
M6 work. Scripted selection is a user action, not model discovery or consent.

The future test date is derived at execution time, at 13:00 Europe/Berlin;
this is not the original frozen corpus scenario or DST-gap/overlap qualification.
The fake completion is not a model answer or evidence of model quality.
No booking/cancellation executes. Source/account authorities and stored proposals
are isolated process-local synthetic state. No institutional authorization,
physical browser/device/AT, production history recovery, cache hit, invoice rate,
model ranking or M6/M7 completion is inferred.

## Reproduction and input identities

```sh
pnpm exec vitest run tests/evaluation-room-planning-fixture.test.ts apps/web/tests/evaluation-room-planning-route.test.ts
```

Final inspected file SHA-256 values:

```json
{
  "scripts/evaluation/room-planning-fixture.ts": "00f8d942ca325e79fee9413a93de2505fa893fc38554089f1e8def6cc56ef4e3",
  "tests/evaluation-room-planning-fixture.test.ts": "76d8fa184d2c24fbaa92b432df40bc57b2cf2d06d2b3f55fdfca77a0f83cba55",
  "apps/web/tests/evaluation-room-planning-route.test.ts": "aa464512915eac681509d58972f677cd86457129a919a1343bf6fd81acc14357"
}
```
