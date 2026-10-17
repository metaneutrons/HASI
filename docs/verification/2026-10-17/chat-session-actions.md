# Conversation action presentation

Date: 2026-10-17. Scope: replace in-flow rename/delete controls which expanded
conversation rows and overlapped their neighbours.

Both the sidebar and mobile history drawer use one native floating popover per
list. The menu is anchored to the chosen row and bounded by the viewport. Rename
and deletion use separate modal dialogs. Rename selects the existing title and
rejects whitespace-only input; deletion names the selected conversation, starts
with focus on Cancel and preserves bookings. Operations retain session-ID targeting
and the existing store's busy/deletion guards.

Verification:

- Production web build, type checking and lint passed. Full local suite: 248
  passed, one PostgreSQL suite skipped locally and required in CI.
- Independent read-only review confirmed shared popover styles, ID targeting,
  keyboard handling and focus restoration without a remaining blocker.
- Desktop Chromium, light: all five conversation rows measured 46 CSS pixels
  before and after opening the menu, with identical vertical positions. Arrow
  navigation moved between menu items; Escape restored focus to the opener.
- Rename selected the complete current title, disabled Save for whitespace,
  preserved the title on Escape and saved a temporary test title on Enter. The
  temporary title was restored afterwards.
- Delete confirmation displayed the selected title and booking-preservation
  explanation; Cancel had initial focus. Cancel/Escape preserved the conversation.
  Destructive store behavior remains covered by the existing store tests.
- Mobile Chromium emulation at 390 × 844 and 320 × 568: floating menu and both
  dialogs remained inside the viewport. Light rename and dark delete dialogs were
  visually inspected. Inner width equalled document scroll width (390 and 320).
- Escape from a menu or nested confirmation retained the mobile history drawer
  and returned focus to the appropriate row action. A lower-list menu remained
  within the 320 × 568 viewport. The unused-chat admission guard remained active.

Exact-head CI and automatic main deployment/live proof are recorded in the PR.
This is browser emulation, not native iPhone/Safari qualification. Native popovers
and dialogs require a current browser.

Interaction references: [WAI menu button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)
and [MDN Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API).
