# Explicit recovery from an unavailable source revision

Date: 2026-10-21. Combined implementation: `5ab9d9af52a6657a53faaa4b42865fc066745cae`.
Supports [M7 #54](https://github.com/metaneutrons/HASI/issues/54), still open.

## Behavior and boundary

An unavailable explicitly cited revision previously ended with a generic error.
The reader now offers **Aktuelle Fassung prüfen** after that error. This is an
explicit user navigation to the same document's current version, not an
automatic replacement of the cited text. The current version is fetched through
the existing authenticated document API and normal actor/source authorization.
Neither navigation metadata nor a source citation grants access.

The recovery URL accepts only a validated document identifier and positive safe
integer revision. Duplicate, ambiguous and malformed revision queries return
not-found. Return metadata accepts only the existing pair of UUID identifiers;
invalid metadata is omitted. A successful read displays the requested and
returned revisions and explains that the original chat citation is unchanged.
A denied current version retains the generic error without another recovery
link or a protected title/body. Error views now expose a primary heading.

The same branch carries the separately qualified populated-conversation heading
correction. Its [26-observation record](populated-chat-heading.md) names its own
exact earlier input revision; it is not qualification of this reader change.

## Completed checks

- Six navigation tests pass, including invalid document paths, untrusted return
  metadata, unsafe integers, duplicate parameters and ambiguous revision modes.
- Eighteen focused navigation/citation/document tests pass across four files.
- Affected ESLint, web types and the optimized Next.js fixture build pass.
- Independent bounded static review found no remaining blocker. A suspected
  unsafe-integer regression was rejected after checking installed Zod 4.6.7:
  its integer schema rejects values outside the JavaScript safe-integer range.
- The optimized fixture started with PostgreSQL, two API replicas, TestIdP and
  a separate reference process. Normal shutdown confirmed owned processes stopped
  and the caller database retained. Synthetic and real model call counts were
  both zero; its isolated HOME was removed.

## Outstanding browser qualification

The current browser integration timed out while opening both attempted owned
IAB tabs; inventory still contained only the two user tabs. The documented
troubleshooting path was consulted. Chrome was unavailable. No user tab was
navigated, no native lock was bypassed, and no browser observation or screenshot
of the new recovery flow is claimed.

Before merge: qualify explicit old-revision failure -> current-version notice ->
return to the originating chat/message with draft preserved. Counterprobe with
a synthetic role-restricted document must deny both old/current reads without
revealing its body. Inspect recovery and error layouts at 320/375/390/768/1280px
in both themes, including enlarged default text, and retain accessibility-scan
incomplete results. The new source and error views remain unqualified until
those actual browser checks finish. Native page zoom, software keyboard and
whole-product M7 acceptance remain open.
