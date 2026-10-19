# Chat service prerequisite and office-request regression

Date: 2026-10-19. Baseline: `00a580c10b035487ce5f7e30c8a40c00d6a52df9`.
Scope: synthetic chat/account workflow under M2/P3/P4 and M4. This does not
establish institutional access or complete those milestones.

A fresh isolated public-demo employee session reproduced the reported cause:
`/api/tools` returned only the knowledge search, the enabled Anny installation's
personal account was `unlinked`, and `/api/resources` returned 403. No model
request or business action was made in that read-only diagnosis; the session
was logged out. A model cannot search resources when the host correctly withholds
its account-dependent tools. Asking for an internal resource ID would not repair
the missing authority.

The chat now checks required current tool access before inference and offers a
native personal-connection control. Demo consent remains an explicit user action;
production adapters retain their validated external authorization flow. A fresh
linked account is checked before continuing the same request. The original user
message, server timestamp, building and interval remain in the conversation;
older connection cards cannot resume a newer request. No booking or cancellation
executes through this control.

The server independently refuses an Anny task when the trusted registry omits
its required read tool, before a provider request or budget reservation. The
response distinguishes service access from provider failure. With the current
resource-search capability, an initial room task requests a native search; it
does not ask users to discover resource IDs. Short user continuations retain
the task; unrelated IT questions do not inherit it. Assistant/source text cannot
establish that task continuity or grant a capability.

The host parser also now recognizes `in 1J` without the word `Gebäude`. The
reported request anchors to 2026-10-19, 10:00–16:00 Europe/Berlin (08:00–14:00Z),
and `mir egal` retains that interval and building while allowing either office
type. Conflicting/negated locations remain unresolved rather than broadening
the search; plain clock numbers are not treated as buildings.

Focused automated results and browser/delivery observations are recorded in the
implementation PR. Real-device/participant acceptance remains M8-A7, and actual
vendor delegation and rights remain M8-A1/A3. An unlinked account is never silently
connected and a missing tool is never replaced with model authority.
