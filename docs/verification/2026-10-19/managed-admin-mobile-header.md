# Managed installation header on narrow screens

Date: 2026-10-19. Component baseline: `afb1cca53b39d76f93172d2ca272b3e338dceded`.
Scope: technical component layout only; actual device/participant acceptance is M8.

The synthetic local component harness revealed that the flexible status badge
could consume the name column even though the card itself did not overflow.
At the existing narrow breakpoint, a two-column grid now reserves the icon
column and the full remaining width for name/identifier. The badge occupies the
next row aligned with the name. Desktop rules remain unchanged.

Browser observations used the actual `ManagedPluginPanel`, CSS modules and
application global styles with synthetic in-memory API responses. At 320 CSS
pixels in the dark theme the name column measured 182 pixels, the badge was on
its own row, and both short and long fixture identities remained within the
card. Document viewport, body and scroll widths all measured 320 pixels. At
390 pixels in the light theme all three widths measured 390 pixels. The local
harness initially counted its iframe border inside its width, producing a
318-pixel content viewport; its test-only box sizing was corrected before
recording exact-width observations. No application minimum-width rule was
changed to hide that harness discrepancy.

This is not an integrated production admin journey, backend lifecycle or
iPhone/Safari/assistive-technology acceptance. No authentication, provider,
Anny, database or other real service call was used by the browser harness.
