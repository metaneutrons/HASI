# Provider observation development qualification

Date: 2026-10-20. This record concerns the fixed-evidence provider runner,
usage meter, operator suite/CLI and explicit Docker evaluation target. No
paid provider request, real institutional content or business write was used.

The focused set contains 46 passing tests across the three new provider test
files and the existing offline runner tests, on Node 24 and Node 26. It covers
actual router serialization with fake Groq/GWDG transports, exclusion of
fixture labels/private candidates, approved pricing snapshots, missing usage,
sanitation of 429 response bodies, no fallback and a one-HTTP-request cap
against Groq's repair path. The repaired request is blocked while conservative
budget holds remain. The response fixture is not a provider quality result.

The meter delegates every settlement operation to the actual admission handle.
Real in-memory ledger tests cover unknown-to-known reconciliation, identical
repeats and conflicting reports. Aggregate-forgery/request-count counterprobes
fail; unknown/unconfirmed usage has null totals. Existing offline input digests
retain their previous domain and byte construction after helper extraction.

The CLI tests invoke the active Node executable on both supported Node versions;
no hardcoded macOS path or inherited credential/database environment is needed.
Plan-only execution succeeds without credentials/database configuration. Invalid
options, duplicate profiles and missing opt-in fail. With valid opt-in/build
revision and a fake database URL, exclusive creation rejects an existing report
before database admission and preserves its bytes. Source authorization comes
from the operator manifest, not case entitlements or expected labels.

The evaluation Docker target built successfully on local Linux arm64. With
network disabled, `--help` and a three-profile plan succeeded: seven selected
fixed-evidence cases, thirteen explicitly excluded cases, zero provider calls
and no budget access. The missing-opt-in execution counterprobe exited 1.
The local image was labelled `uncommitted-qualification`, which cannot satisfy
the live CLI's revision check. This is not a release/source-attestation claim;
final exact-source qualification and CI evidence belong to the implementation PR.

Affected type-aware lint and root/web type checks pass. An independent bounded
source review found no critical blocker; it did not run tests. Review explicitly
retains operator obligations to verify actual serving-store binding and source
revision before spending. Use an absolute writable output path/mount in the
non-root operator image, since `/workspace` remains root owned.

Limits: no current-deployment budget-binding proof or actual provider comparison
is established by these tests. Cache state and resolved alias versions remain
unknown. Citation presence is a literal bounded assertion, not citation support,
factual completeness or human scoring. The draft corpus is not gold. Full M6
and M7 acceptance remain open.
