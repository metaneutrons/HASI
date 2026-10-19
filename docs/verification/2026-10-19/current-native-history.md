# Current authority for retained native history

Date: 2026-10-19. Base: `104c45bd73edff27d9bf9634632d0038f830ee7f`.
Scope: technical TestIdP/reference and synthetic fixtures. This record does not
accept M2/P3, full deployed browser journeys, or institutional source rights.

## Observed gap and boundary

Protected workspace reads revalidated knowledge references and derived answers,
but native room/booking/proposal cards bypassed display-time authorization when
they had a native-looking field or tool label. Cached Anny-derived assistant
text also had no current account/configuration fence. The experimental view's
error fallback could display its cached initial body after access was denied.

The authenticated read-only `/api/history/authority` route now exposes only an
opaque versioned digest of the current subject/actor and sorted installation,
configuration/lifecycle and account-authority bindings. It invokes no business
tool and exposes no customer ID, raw claims or credentials. Registry refresh
may validate current service/managed bindings. Known account denial is included
as inaccessible; failed authoritative state resolution fails closed.

Production assistant evidence MACs bind that digest along with subject scope,
conversation, message body, context IDs and expiry. The current digest is
required during history rebuild, checked before every provider attempt and
again after completion. It is not model instruction text or a grant of access.
Existing unsigned/unfenced pre-release assistant records become unavailable.
A changed optional installation/account/configuration conservatively invalidates
all retained derived assistant text, rather than guessing per-message dependencies.

## Native reconstruction and failure behavior

Protected workspace load/save makes only fixed authenticated GETs for current
resources, own bookings and exact subject-authorized proposals. It reconstructs
cards from those returned records, not browser labels or cached names/statuses.
Requested times remain task input; cached availability is cleared and must be
queried again. Foreign/removed targets disappear. Expired pending proposals
are displayed invalidated. At most 32 unique proposals across the workspace are
read; overflow is unavailable. Proposal GET may perform the existing pending
binding-invalidation CAS when authority has changed; it does not prepare,
execute or reconcile a business action. A separate host confirmation still performs its existing checks.

Current authority is checked before and after workspace reconstruction. A race
fails instead of returning a mixed snapshot. The signed CAS store persists
revoked-data redaction. User-authored messages preserve only text/identity/time;
a user role or helper label cannot smuggle a cached structured card through.
Failure to validate protected persistence clears native and sourced assistant
content, chosen targets and old active actions while preserving user questions
and the unsent draft. Unverifiable helper prose is replaced by an unavailable
notice. This is deliberately conservative until generic tool-result receipts
support independently verifiable prose.

The experimental PluginResultApp never seeds the view or its error disclosure
with an old result body. It retains only requested date/time arguments and
performs fresh permitted typed reads; old availability is never asserted current.
Host-native cards supply the separately reauthorized fallback. Public third-party
Apps remain disabled under the existing feasibility decision.

## Verification

Focused fixtures cover valid current records versus revoked access, forged helper
text/resource fields, a user-role structured-card bypass, foreign booking IDs,
current cancellation status, lost source access, expired/foreign proposals,
proposal-read bounds, authority drift before persistence, subject-bound message
receipts, configuration/account revisions and sanitized authority response parsing.
They preserve the user question/draft and demonstrate no business writes.

A private production-React component harness used the actual PluginResultApp,
API wrapper and policy module, with synthetic HTTP 403/404 presentation responses.
At 320 px, access denial and retry showed zero cached name/location disclosure,
zero iframes and two GETs/zero writes. A missing view opened with keyboard Return
showed one GET/zero writes and no cached name/location. The authorized mock host
card remained visible; document width equalled 320 px. At 390 px the missing-view
state also had no horizontal overflow. These are component checks, not full
Next/TestIdP/device acceptance. The loopback server and browser tab were stopped
and the viewport override reset afterwards.

Harness bundle SHA-256:
`57ac243e53419b5fa549f8f69395fbcd63509eb6db6572b77be0bcace23699a0`.
No provider, live HsH or live Anny call was made.

## Source identities

| File | SHA-256 |
| --- | --- |
| `apps/api/src/registry.ts` | `830f2f5b933ab012e704a265ca92ca0edbcb8baa9ea02986016f720d3ae03465` |
| `apps/api/src/index.ts` | `db173aa6f954831f1b52b8d50de9851c67c9b4ebe3d1506f0d5912008ddf61fc` |
| `apps/web/src/lib/chat-contract.ts` | `a257871cafc8125d0c55cfc07bb7abc14672be95f609203836715623721da971` |
| `apps/web/src/lib/server/knowledge-evidence.ts` | `f0ca8614d3599521514f6b81c0b6603d93d962ce6f7dddd8d30e2c60b724c68e` |
| `apps/web/src/lib/server/history-authority.ts` | `7e2e5c27ea91904cf7f0058696f6c2c911a991af8ce6b607df95d9639a22914c` |
| `apps/web/src/lib/server/native-history.ts` | `c8fb3aa53f32455c48e2e5e84e9d994dfbe80b78b9aad6870abf48b66c55e198` |
| `apps/web/src/lib/server/protected-workspaces.ts` | `6769307e90e9f4d7b45a5b626334c399035989fe9414ed8e397a1f3a9211d6e1` |
| `apps/web/src/lib/chat-workspace-store.ts` | `11116def9543f88f9e60bdb2798a922e51fa73747106fc52caddd3b95b86c49a` |
| `apps/web/src/components/plugin-result-app.tsx` | `60ce81101f55fc285a57001c3ead6bb3960c94457eea9561b7524712c33abb88` |
