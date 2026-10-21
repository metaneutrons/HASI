# Heading navigation in populated conversations

Date: 2026-10-21. Implemented revision:
`71f4dca07e06bed28d7995c4db61f5912264b6ff`.
Supporting [M7 #54](https://github.com/metaneutrons/HASI/issues/54), still open.
The [machine result](populated-chat-heading-result.json) records exact inputs,
reported browser identity and all 26 observations.

The preceding [larger-font matrix](relative-interface-type.md) detected
`page-has-heading-one` in four populated desktop/tablet chat views. The welcome
screen already had a primary heading, but the transcript replaced it without
an equivalent heading for assistive navigation. Populated conversations now
have a visually hidden `Unterhaltung` h1. Empty conversations retain the welcome
h1, and inactive conversation sections remain hidden. No visible layout or
action/model behavior changes.

The optimized local fixture used PostgreSQL, two APIs, synthetic TestIdP and a
separate reference process. This smaller UI exercise did not require managed
containers or make model calls. The browser's reduced user-agent reports
Chromium/Chrome 155.0.0.0; it is not a full native engine or OS build identity.
Axe 4.14.0 used the same verified bundle as the preceding matrix.

All 26 observations have zero detected violations and no horizontal document
overflow: 11 larger-default-font login checks, one initial empty-chat check,
ten populated chat checks across five widths and both themes, two enlarged
desktop/tablet checks, and new-empty/returned-populated conversation checks.
The new empty chat exposes one active welcome heading while the previous
transcript h1 remains in a hidden section. Returning exposes the transcript h1.
The earlier actual-build failure is retained as the counterprobe; the scan rule
was not excluded or suppressed. Incomplete contrast and popup-reference checks
remain unqualified.

Affected ESLint, web types and the optimized build pass. No implementation-
mirroring unit test was added for this single conditional element. Normal
shutdown stopped owned processes and retained the caller's database. The test
identity was signed out, font and viewport settings restored, own tab closed
and isolated HOME removed.

This is browser/accessibility-tree evidence, not native assistive technology,
page zoom, software keyboard, model-quality or complete M7 acceptance. The
supplied failed booking/VPN dialogue remains open in M6.
