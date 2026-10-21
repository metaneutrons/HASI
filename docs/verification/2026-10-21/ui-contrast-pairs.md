# Rendered contrast pairs and confirmation keyboard geometry

The [corrected rendered-text report](rendered-contrast.md) now supplies separate
qualified measurements for 72 named desktop groups. The provisional numbers in
this older record remain unaccepted; its confirmation-keyboard geometry evidence
retains its separate scope.

## Contrast correction

The welcome paragraph now uses the stronger existing `--ink-soft` text color
instead of `--muted`. This is a bounded visual contrast improvement. It does
not close the outstanding contrast qualification gate.

The [provisional observations](ui-contrast-pairs-result.json) bind the initial
measurements to deployed base `f55d20ed809ef4e6015abf5ccda3774af34c71b8`.
They retain the candidate overlay results and 56 mobile navigation pairs, but
**none of these contrast results is accepted as normative P6 evidence**. The
nested `allPassed` values describe the provisional analyzer, not acceptance.
The candidate welcome rule was temporarily overlaid and removed; it is not
post-deployment verification of the source rule.

![Light welcome candidate](welcome-text-light-candidate.png)

## Measurement correction and remaining work

The original analyzer compared computed sRGB foregrounds with untagged PNG
backing channels as though both had the same color interpretation. Subsequent
actual browser controls exposed two separate limitations:

- A default viewport screenshot may use a different pixel-coordinate scale.
  Explicit CSS-pixel clips, the document scroll offset and settled paint are
  required. A calibrated 100×40 CSS-pixel reference correctly preserves its
  red/blue half boundary. The unqualified whole-viewport and unstable-scroll
  experimental batches are excluded entirely.
- The screenshot pipeline changes known CSS primary-color channel values and
  supplies no ICC profile. Black-on-white and white-on-white controls give
  the expected 21:1/1:1 and exit 0/1, but those neutral controls cannot prove
  the color interpretation for the actual backgrounds. An sRGB-only numerical
  result is insufficient. Color-space calibration and independent validation
  remain required before claiming normative contrast ratios or accepting pairs.

A corrected exploratory capture waits for paint after applying and restoring
text-fill-only masking and includes the page scroll offset. The 15 welcome
candidates in each theme reproduce the original provisional channel ratios,
but this does not repair the missing color-space qualification. The source
paragraph change is retained; the numerical acceptance claim is withdrawn.

The remaining measurement must bind actual foreground/background composition,
clipping and overlap to the current rendered source and verify its coordinate,
color and rejection behavior. A reported artifact may not turn a failed or
uncertain measurement into an accepted contrast result. This record explicitly
keeps those targets open under P6-A3. The relevant distinction between encoded
color spaces is documented by [CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code).

## Confirmation with simulated software keyboard

The deployed base's actual public demo was used with an explicitly selected
**Dialog-Demo** profile (`offline`), not a language model. The documented
synthetic account connection was completed. A search for a workplace in 1J,
tomorrow 10:00–16:00, was narrowed to an office with one workplace; an actual
mock booking proposal was prepared. The confirmation button was never clicked.
No model call or booking execution occurred.

The [confirmation observations](confirmation-keyboard-result.json) record an
explicit 430px VisualViewport override and labelled keyboard occlusion overlay
against the real viewport hook. The composer retained focus and its exact
unsent draft. The confirmation was scrolled into the available message region,
without activating it; its center hit-tested to the actual button.

| Viewport and text | Confirmation bounds | Send bounds | Horizontal overflow |
| --- | --- | --- | --- |
| 390×844, 16px root | y225.03–271.03, height46 | y367–411 | None |
| 320×844, 32px root | y175.55–269.55, height94 | y359–403 | None |

Both controls are inside the simulated 430px visible area. Hidden clipboard
textareas were excluded: draft and focus checks use the actual composer.
The fixture and root-text override were removed afterward. These measurements
qualify reachability through scrolling; they do not claim that every long
proposal fits without scrolling.

![Confirmation and retained draft with large text](confirmation-keyboard-large-text.png)

This is software-keyboard geometry simulation, not native iPhone keyboard,
assistive-technology or participant acceptance. Those remain M8. P4's admin
keyboard requirement concerns keyboard operation/focus; the technical basis
does not require every admin action to run beneath a simulated software
keyboard. Named admin connection-test/update/error/reconnect focus evidence,
remaining contrast targets and final P1–P6 reconciliation are still separate.
