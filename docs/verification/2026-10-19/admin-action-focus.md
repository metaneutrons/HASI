# Admin action focus recovery

Date: 2026-10-19. Baseline `c0618a86a3209f2f017296f87b9beedcd8f3ecc2`
with the focus changes below. Scope: actual rendered admin components against
a loopback in-memory API fixture, not the installer or a production deployment.

## Observed defect and change

Disabling or replacing an action button during an asynchronous operation left
keyboard focus on the document body. A shared one-shot controller now restores
it after the corresponding React layout commit. It waits for an enabled target,
retains the same installation, and cancels recovery after user interaction,
focus movement, window focus loss or unmount. Captured descendant blur events
do not count as window focus loss. No request is repeated or automatically
confirmed by this behavior.

The configuration panel targets explicit reload after a revision conflict,
the safe keep-inputs action in its discard confirmation, the first field after
explicit reload, separate activation after a saved draft, and the summary after
activation. Connection/update checks and manual reload recover to their useful
controls. Managed operations target the same command's status check while
pending, review after staging, activation after approval, and the installation's
status after completion. An outstanding restore-plan requirement targets its
input rather than a disabled review control.

## Browser exercise

Root used the actual `ManagedPluginPanel`, `PluginConfigPanel` and
`PluginConfigFields` in the in-app Chromium browser. At 390 CSS pixels/light:

| Explicit operator action / fixture result | Observed final focus |
| --- | --- |
| Save valid fields / one synthetic HTTP 409 | Serverstand neu laden |
| Open discard confirmation | Eingaben behalten |
| Keep local inputs | Serverstand neu laden |
| Explicitly discard and reload | Dienstbezeichnung input |
| Save fresh draft | Entwurf aktivieren |
| Activate configuration separately | Configuration summary |
| Stage accepted but response lost (502) | Status prüfen |
| Read same command / running | Status prüfen |
| Read same command / completed | Prüfung bestätigen |
| Approve review | Version aktivieren |
| Activate release separately | Installation status: Aktiv |

Final fixture counters were two draft POSTs (one 409, one saved), one config
activation, one Stage POST, two same-command status GETs (running/completed),
one review POST and one release activation. There were no unknown routes.
The single Stage command ID remained
`bc9eb6b2-83c5-4062-a191-9df6d5995c99`; no duplicate Stage was sent.

At 320 CSS pixels/dark with the schema form open, body and document client and
scroll widths were all 320, with no descendant outside the viewport. Visible
buttons, selects and text/number fields were at least 44 pixels high. The
20-pixel checkbox had a 44-pixel label hit area. These are component/browser
measurements, not physical-device or native assistive-technology acceptance.

Tested component SHA-256 identities:

- Managed panel: `c22c0e527928c7532ffb738819b6646aea6c0be72c95aeabc97bbad39ea842b7`.
- Configuration panel: `33ecbc70bebf537c8f1006848c7f05bd64913aa4de63a6fae9a3179f31a23d08`.
- Fields: `93e01ae80c4fcffa271d4e6ac57791dd90d8251a4e20a6fbe2313587b117f4e9`.

Four focused hook tests cover disabled-trigger recovery, enabled-target waiting,
user focus movement, window versus descendant blur and disposal. Typecheck,
scoped lint and whitespace checks pass. Independent code review found no blocker
within these files. Its attempted focused test invocation accidentally selected
the full suite without a test database: 1,052 tests passed and six skipped. That
run is not the mandatory PostgreSQL integration gate.

A separate browser countercase delayed only the loopback catalog refresh by
three seconds. While its trigger remained disabled, the operator moved to the
service-label input and entered `Fokus bleibt hier`. After the response completed
and the refresh button was enabled again, that input retained focus and its
value. Product source and APIs were unchanged by the temporary fixture delay.

Remaining scope includes remote update/connection-test UI paths, the complete
integrated admin lifecycle and M8 device/participant acceptance. This record
does not establish the separately agreed 200 ms UI latency target.
