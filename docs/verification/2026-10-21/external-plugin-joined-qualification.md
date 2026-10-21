# External managed-plugin browser qualification

These bounded observations supplement M2 P4–P6. They do not accept M2, M6 or
M7. The first two runs use unmodified HASI
`0afa6270a096dec1b8cc5d9f5ad5c2324c43d2f1`. A third diagnostic run adds
temporary API phase logging; that patch is not a product change and was
subsequently removed.

## Frozen external inputs

A separate local Git repository derives honestly from the reviewed reference
example. Its managed-state profile is applied before its commits and packaging.
All five packaged source files match their respective annotated tags exactly.
The packaging/admission steps leave both payloads and operator sidecars
unchanged.

| Version | Exact source commit | Payload SHA-256 |
| --- | --- | --- |
| 1.0.0 | `59e15b00c36fdef1cb4083c019dd56f0a628942b` | `6ca8a1eabf5c26acf414b253e78b20c6bf1a338d8255ba1e91c6ba91b6b389ee` |
| 1.0.1 | `40e30f3c1b3900e0505144e11d11326d2c3904f1` | `62e8b081a4d8934d026104d8b22ebee935c50812c42ddc81c25254c45a492c1f` |

The trusted fixture approves a synthetic publisher and signs the actual
source/payload/license inventory into version-2 release envelopes and their
immutable image bindings. The unsigned input sidecar is an operator assertion;
it is not itself publisher authentication. This is a local technical
qualification, not public distribution, independent human authorship or a
reproducible-build claim. The plan does not require a marketplace or unrelated
publisher for this technical demonstration.

## Observed product journeys

Each run uses an optimized Next.js process, two API processes, a separate
installer worker, actual Docker plugin containers, PostgreSQL and Test-IdP.
Only synthetic local model responses are used; real provider calls are zero.
The disposable database is separate from existing development and public data.

The first run observes required-field gating, configuration draft/save/activate,
release stage/review/activate, central catalog connection, separate personal
consent, a v1 status with counter zero, explicit confirmation and the same
confirmed receipt after reload. A pending v1 proposal precedes a v2 activation.
The subsequent stale attempt leaves the counter at one; a fresh v2 read returns
version 1.0.1 and the same counter. Context recovery is not clean: protected
answers become unavailable and a retry is required. This is evidence of the
unchanged effect count, not acceptance of the complete stale-action UX.

The first run's 30-minute bound stops it normally with exit zero. Its late
connection-refused observations occur after shutdown and are not product
defects. Cleanup removes four owned containers, three networks and two images.

The second run's first confirmation becomes `outcome_unknown` without injected
failure. Status reads do not establish a terminal result. The observed managed
state has no business counter or execution receipt. No new business write is
attempted. Expiry/renewal returns the same unknown proposal and initially the
same draft; a later observation shows an older draft. The cause of that draft
transition is not established. The staged candidate is discarded; normal
cleanup removes two containers, three networks and two images.

The third run's phase-only diagnostics observe a successful v1 confirmation:
state session ready at 5,943 ms, connected at 8,647 ms, tool dispatched at
9,988 ms and returned at 19,907 ms from invocation entry. These are single
diagnostic timings, not a performance percentile or the completed UI latency.
A subsequent preparation is hidden while another administration tab is open;
the observation alone does not establish that tab as the cause.

The third run completes UI stage/review/activate of v2 and explicit rollback to
v1. The durable counter remains one at both points. The host build ID remains
unchanged across this update and rollback. Current release changes from
`d84b1c898aea4d7cfd483e23be00c84be64d0dbe831f87ebd77783ba04118511`
back to
`11a14ce1847bb5b56c1404c3311e04aac1b361d5083786a443cdb7283a4897e9`.
The worker and API processes remain in the same held composition. Normal
cleanup removes four containers, three networks and two images. Diagnostic API
source changes are restored byte-for-byte afterwards.

## Presentation and limitations

The first run measures document/scroll widths 320, 375, 390, 768 and 1280 with
32px root text in both themes. Stable theme scans have no confirmed axe
violations; incomplete contrast checks and an `aria-label` on an ungrouped
release-state `div` remain explicit review items. An immediate theme-transition
scan contains contrast failures; its stable repeat is retained separately.
The initial high-level screenshots have incorrect physical scaling and are
disqualified as full-height phone evidence. Later CDP captures use an explicit
390×844 CSS-pixel clip and show the actual phone layout. Neither approach
qualifies native devices, software keyboards or assistive technology.

The basic independent configuration/chat/action/update/rollback path has
positive observations. The combined error/recovery and multi-tab workspace
journey has failures, so it remains open. Scripted lost-acknowledgement
interception was prepared but not executed; it is not claimed. Earlier
API/container crash and receipt evidence remains separate. No human model
quality score, cache hit, provider savings or institutional acceptance is
established here.

Source inspection identifies a concrete independent defect: a failed current
history-authority lookup is converted into an empty authority, which can cause
`loadCurrent()` to persist the redacted workspace. The corresponding recovery
change and its positive/denial tests are recorded separately. It is not yet
proven to explain every observed unknown action, draft transition or digest
mismatch.
