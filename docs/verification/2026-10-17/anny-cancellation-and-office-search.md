# Cancellation and office search qualification

Scope: owned simulated booking cancellation, compact result presentation, and
office preference derived from the actual resource hierarchy. Live institutional
SSO, customer-token delegation and real cancellation writes remain unqualified.

## Source evidence

A fresh authorized read-only Anny catalog query on 2026-10-17 returned 61 resource
IDs. IDs, parent links and quantities match the committed sanitized snapshot
SHA-256 `4b395851e0c4f3201048d6aa0e7d455996ad4b4dac1fb01edd5d570c8d973705`.
All 18 offices have child workplace counts equal to their parent quantity:
eight one-workplace offices, seven two-workplace offices, three three-workplace
offices. Building 1J has seven one-workplace offices and six shared offices;
six workplace roots have no parent office classification. No booking,
availability or cancellation request was made against live Anny.

`officeWorkplaceCount` is derived before user filtering. A restricted view with
one accessible child must not turn a shared office into an apparent single
office. The additional metadata does not change the mock calendar namespace:
the key still hashes resource/service IDs only.

## Protocol, authorization and persistence

- Client/mock tests verify the documented Admin cancellation GET, write opt-in,
  no-body organization-scoped request, redirect rejection, one request after
  ambiguous transport failure, retained canceled history and released availability.
- Eleven signed-registry cancellation tests cover preparation without mutation,
  customer/resource boundaries, revoked rights, changed intervals/resources,
  past/terminal bookings, denied direct execute, idempotent canceled state and
  failure to establish the post-write result.
- Real HTTP/MCP integration checks memory and snapshot catalogs through independent
  runtime instances: pending cancellation has no effect; foreign workspace/account,
  foreign proposal reads and altered confirmation are denied; concurrent/repeated
  confirmation preserves one result; canceled status persists and availability
  becomes free. The same cases run against PostgreSQL in required CI.
- Independent review found no backend blocker. A UI review found a possible
  action mismatch in restored cards; the fix re-reads the stored proposal before
  posting confirmation and checks the response action/snapshot and cancellation
  booking ID before displaying success. The reviewer confirmed that fix.

## Local browser checks

Production build with the isolated local mock; Chromium desktop and mobile
emulation, without provider credentials:

- The exact request “Ich brauche am kommenden Montag ein Büro im Gebäude 1J von
  8-16 Uhr” first asked the office preference. “Ein Einzelbüro bitte” retained
  1J, 2026-10-19 and 08:00–16:00. Seven matching workplaces were checked; four
  rows appeared initially and “Weitere 3 anzeigen” exposed all seven. Collapsing
  restored four rows. Exact available intervals suppressed extra alternate times.
- Direct single-office wording initially missed intent classification; a focused
  regression test and corrected browser rerun verified the fix.
- A newly created test booking was explicitly confirmed, listed, proposed for
  cancellation and confirmed. “Ja” in the chat requested use of the confirmation
  card and did not execute it. After button confirmation the booking card and
  booking overview showed “Storniert”; the proposal button was disabled.
- Dark cancellation at 390 × 844 and light office results at 320 × 568 remained
  within the viewport. Document scroll width equalled inner width at both sizes.
  Details were collapsed and action controls remained touch-sized. This emulation
  does not establish native iPhone/Safari qualification.

Production build, lint, types and full local test results, exact-head required CI,
automatic main deployment and final live provider/UI proof are recorded in the PR.
There are no live Anny writes or new credentials in this delivery. Public demo
booking/cancellation execution remains entirely simulated.

## Live model observation and follow-up

After the initial deployment, Groq GPT-OSS 120B correctly returned the office-type
question and seven single-office matches. A subsequent call hit its provider rate
limit. Following desk selection, the model then returned Wednesday 2026-10-21
instead of the user's Monday 2026-10-19. No booking was committed. This observation
is a model-quality failure, not a passing end-to-end time qualification.

The follow-up binds complete online room requests to their server-issued user
message time, retains that interval across office preferences, and rejects model
availability/proposal calls which silently change its start or duration. A desk
selection with a complete interval checks availability directly through the typed
tool bridge, avoiding another date-generation call. An explicitly selected,
labelled alternate slot remains a separate user action. Six focused regression
tests cover Monday persistence, changed days/start/duration, equivalent offsets,
incomplete constraints and the spring/fall Berlin daylight-saving gaps/repeated
hours. Complete unresolved times require clarification and cannot fall back to
a model-chosen replacement. Final live evidence is recorded separately in the
follow-up PR; the preceding failure is retained here.
