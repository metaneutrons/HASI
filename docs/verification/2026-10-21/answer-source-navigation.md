# Answer-adjacent knowledge references

Date: 2026-10-21. Base: `27cf2a4152d7332852ac3d04b5d496ea5a8e556a`.
Related milestone: [M6 #53](https://github.com/metaneutrons/HASI/issues/53).

## Change and boundary

Retrieved documents remain on the tool-result message as an initially collapsed
**Suchtreffer** disclosure with a count. Opening it reveals compact document
links. The answer has its own **Quellen dieser Antwort** list, generated in the
same Markdown AST pass that produces its inline citation links. It includes
only eligible references actually rendered in that answer, once each, in first
citation order. The full evidence-context mapping is not mislabelled as a list
of citations. Code, HTML, images and authored/reference/GFM links remain excluded.

Both inline and appended links use normalized host-owned same-origin reader
URLs, with exact revision and originating chat/message context. The existing
current-rights/revision check remains at document read time. No model-selected
origin, access bypass or additional authorization is introduced. Appended sources
are presentation only; original Markdown copy/source remains unchanged.

The optional service-IT replica link now says **Demo-Website öffnen** and explains
that the destination is restricted to approved university addresses. The link
still redirects the browser; it is not a HASI network proxy. The authorized
reader copy remains available subject to its normal access check.

## Focused verification

33 tests pass across the Markdown, answer citation mapping, citation identity,
return navigation and message-copy suites. New positive/counter cases verify
an answer-adjacent de-duplicated list, unused/wrong-revision/unmapped exclusions,
code/authored-link/HTML/GFM-autolink exclusions, exact return metadata, opt-in
rendering and first-use order including a GFM table. Affected web types and lint
passed. An independent bounded review found no rendering, access, revision or
raw-copy defect; its replica-link wording concern was corrected.

## Browser observations

The isolated joined fixture used actual Next.js, TestIdP, two API processes and
caller-owned loopback PostgreSQL. The browser explicitly selected Dialog-Demo;
no real provider was configured or called, and no booking was performed.

At 390px, an actual VPN search returned three revision-2 documents. Results were
initially collapsed and opened normally. Opening the first source, reloading its
reader, and returning preserved the unsent draft and focused the originating
message. No document-level horizontal overflow was observed.

A temporary local client component preview then supplied two synthetic eligible
citations and one unused mapping to the actual Markdown component. It showed
only the two cited references at 390px dark, 320px light and 1280px dark widths.
The 390px source links measured 51px high. The 320px and 390px views had no
horizontal overflow. These screenshots show that component fixture, not a model
answer or a production authorization exercise:

- [390px dark](answer-sources-dark.jpg)
- [320px light](answer-sources-light.jpg)

The preview route was removed, the owned browser tab closed, viewport override
reset, synthetic account logged out, fixture stopped with owned-process cleanup
confirmed, and isolated HOME removed. Caller-owned PostgreSQL was retained.

## Remaining limits

The complete supplied booking → VPN → missing-confirmation Groq dialogue remains
unaccepted. This change does not fix generated fragmentary FAQ titles or prove
model answer quality. The external restricted replica was not visited in this
browser run. Physical iPhone/native assistive-technology acceptance remains M8;
this is bounded technical browser/component evidence, not full M6/M7 acceptance.
