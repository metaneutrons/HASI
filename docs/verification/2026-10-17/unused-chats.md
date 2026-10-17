# Unused conversation admission

Date: 2026-10-17. Scope: prevent adding another chat while the active chat has no
messages, model history or non-whitespace draft.

The store enforces the rule for every caller; the toolbar, sidebar and mobile
drawer use the same admission helper. An unused chat elsewhere in the account is
selected before creating another. Reuse preserves the existing profile. Sessions
with drafts/messages or in-flight work are not reused. New sessions still use the
operator default; the existing account boundary and twenty-session limit remain.
No existing conversations are deleted or merged.

Verification:
- Ten focused store tests passed, covering repeated creation, whitespace,
  draft preservation, reloaded storage, model selection and reuse at the limit.
- Full local suite: 248 passed; one PostgreSQL suite skipped locally and required
  in CI. Web build, lint and type checks passed.
- Desktop browser: both visible New Chat actions disabled for the unused active
  session, enabled after draft input; switching to a previous conversation then
  choosing New Chat selected the existing empty session with the count unchanged.
- Mobile Chromium emulation: the drawer's New Chat action was disabled;
  innerWidth and document scrollWidth both measured390 CSS pixels.

Required exact-head CI and automatic main deployment are recorded in the PR.
Browser emulation does not establish native iPhone/Safari qualification.
