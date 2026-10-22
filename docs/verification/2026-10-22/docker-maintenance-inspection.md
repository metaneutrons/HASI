# Docker maintenance inspection format

The evaluation operator build was held before dispatch at 7.09 GiB free space.
The existing 8 GiB admission floor and 12 GiB operational recovery threshold remain
unchanged. The installed maintenance script matched repository SHA-256
`41726d9da5fab351cffdd52c6bf43fd77e2fe213ea85b7a6d3b01ec11102f906`.
Its read-only low-space path failed during narrow container-image inspection;
the scheduled 04:12:24Z maintenance invocation also failed. The deployment
controller was stopped under the runbook while the current application remained
available. This is a new operational defect, not a completed M7 criterion.

## Cause and bounded correction

An ordinary JavaScript string consumed the escaped quotes needed inside Docker's
Go-template format. Field-name-only mocked checks did not execute Docker's parser.
The actual host rejected the generated format with a template parsing error.
The corrected constant uses `String.raw`; its runtime contract is also checked
in the existing injected-command test. Inspection remains restricted to
`.Config.Image` and `.Image`. It never requests the complete inspect object,
container environment, command arguments or runtime credentials.

No cleanup policy, lock, byte/output/timeout bound, journal validation, compatible
floor, latest-two retention, container reference/image-ID protection, or deletion
scope changes. All 13 focused Node tests pass. The existing failure paths remain
fail-closed; the fix makes the intended bounded collector executable.

## Actual read-only host qualification

Candidate source SHA-256:
`9999e12ca5bff0390bff8d696a1212b023614bb5ad905814a960e373acfe68a3`.
The candidate was staged separately; the installed service script was not replaced
for these probes. Environment: Linux x64, Node 24.22.0, Docker client/server 29.9.1,
UID 0 as required for this host-only maintenance tool.

- The actual collector reads 13 containers and includes the current app image ID
  `sha256:d910f1c2c1b8e1d410ecfa10b68278899c1736ca2120a07ab73720b73cb5b5a2`.
- A counterprobe strips the required escapes, asserts equality with the installed
  legacy format, and executes that narrow inspect command against the same Docker
  daemon. Docker rejects it with exit 64 and the expected template-parser error.
  An initial probe incorrectly expected exit 1; that attempt is not acceptance
  evidence. The corrected version records Docker's actual exit 64.
- The complete candidate dry run reports 8 eligible old app-image tags at
  `7616544768` free bytes, 0 builder-prune runs and 0 removed image tags.

These probes perform no pruning, image/container/volume deletion, credential
lookup, provider request or business-state mutation. They prove format parsing
and the dry-run path, not a completed storage recovery. Full repository/CI
qualification, installed-source identity, an authorized maintenance apply,
retained-state verification and controller resumption must be recorded separately
before claiming deployment recovery or M7 acceptance.
