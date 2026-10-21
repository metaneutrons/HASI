# Source and license inventory bound to managed images

Date: 2026-10-21. Base: `826531cf6d3677c24eea563abf2dd9797360df64`.
Implementation: `9bd45f675aa948126d3fc9484386df3d126dcbf6`.
Supports M2 P5-A2/P6-A4; not complete P5/P6 or M7 acceptance.

The previous publisher envelope authenticated the manifest and image, while the
administrator's license and inventory digest came from unsigned catalog fields.
The version-2 envelope now authenticates source repository/commit, payload
digest, root license and the complete canonical package/license inventory.
The SDK exports a publisher-side contract that does not import the host API.
Administrator metadata derives from verified provenance. The Docker driver
requires the matching built-image provenance digest before any container
creation or plugin-secret resolution.

See the [contract and explicit pre-release transition](../../architecture/plugin-release-provenance.md).
No compatibility signature path or stored-state reset is introduced.

## Actual image qualification and corrected integration failure

The first actual Linux/arm64 container run failed with `docker_driver_unknown`
and `cleanup_unconfirmed`. Docker inherited the 4,890-character provenance JSON
label into the container. The existing ownership parser rejects label values
over 512 characters, so it could not admit or reconcile that container. The
unrelated-label limit was not relaxed: the SDK now embeds a fixed 71-character
SHA-256 digest of the complete canonical record; full provenance remains in the
signed envelope. The fake Engine now models inherited image labels too.

Before a second run, the operator independently verified the exact observed
container ID, owner, installation, operation, derived name, image digest/owner,
provenance-label identity and network membership. Only that container, its empty
owned network and its exact image were removed. The other ten containers were
retained, with exact before/after inventory equality. The failed attempt remains
in the [machine evidence](plugin-release-provenance-result.json).

After replacing the oversized label, the actual run passed. Independent review
then required a pinned source commit and a reason-specific denial oracle. The
final healthy run with both corrections also passed, and is the recorded
`healthyRun`. Earlier image-admission errors cannot count as a successful
provenance counterprobe. These runs used Node 24.21.0/macOS arm64 with Docker client
29.9.0/server 29.2.1 and Linux/arm64 containers. Its freshly packaged image,
manifest, payload and source identities are retained in that evidence. The
reference source's five files matched Git commit
`826531cf6d3677c24eea563abf2dd9797360df64`; the SDK/runtime payload has its own
artifact digest. This is a local synthetic publisher, not a separately trusted
external release or reproducible-build proof.

A freshly valid Ed25519 signature over a different source commit but the same
image was admitted by signature verification and rejected by the image gate.
Exact container inventory and the secret-resolution counter remained unchanged.
The valid image then started normally, served the expected manifest and one
signed MCP read, and denied a validly signed foreign installation. Existing
nonroot/read-only/seccomp/capability/resource constraints and blocked plugin
egress passed, with a positive external-network control. Normal owned cleanup
passed and removed the isolated HOME. No model provider was called.

## Verification scope

Focused SDK/driver tests cover canonical ordering, duplicate/ambiguous inventory,
empty/oversized inventory and UTF-8 bounds, credential-bearing/noncanonical URLs,
commit shape, signature mutation, frozen nested provenance, missing/rebound
labels, validly re-signed metadata for an old image and pre-secret/pre-create
denial. Producer fixtures check source mutations precede their actual Git commit,
tags bind the packaged input files, and supplied source identity is preserved.

The first managed update/state attempt reached a confirmed v1 write, the v2 read,
a durable second source write, the expected process exit and a fresh login/read
of action count two. Its explicit reconciliation returned HTTP 200 but retained
`outcome_unknown`, so the run failed at `managed_crash_reconciliation_invalid`.
All four containers, three networks, two images and 36 owned state rows were
cleaned normally. This is a failed recovery observation, not acceptance. Added
bounded status/duration/source/journal diagnostics preserve the original oracle;
they do not accept unknown state or replay the write.

The diagnostic attempt also failed that first-response oracle. Its status call
took 11,958 ms; source count stayed two and confirmed journal count increased
from one to two, while the public and durable proposal stayed unknown. This
narrows the boundary to the status acknowledgement/host projection after a
confirmed journal, without yet identifying the underlying exception. The next
journey models one further explicit status check after the normal cooldown,
conditional on the exact original binding/receipt already being confirmed and
the durable proposal retaining its owner and execution identity. It still
requires a terminal confirmed proposal and unchanged source count. Unknown or
unconfirmed evidence cannot pass; no execution endpoint is retried.

## Transportable operator package

The actual standalone operator bundle was built with its offline artifact,
complete file inventory and five admission/corruption counterprobes. Valid
original/copied artifacts pass through admission before the deliberately missing
Docker executable. A changed source file fails the new source-binding gate; a
separate one-byte change to `LICENSE` fails payload integrity. The earlier
payload-only oracle expected the wrong reason for a source-file corruption and
was split rather than accepting any error.

An initial isolated invocation lacked the metadata cache after environment
sanitization and failed closed with `ERR_PNPM_NO_OFFLINE_META`. Explicit
preparation and packaging in the same sanitized environment resolved that
environment error; packaging itself did not retry online. The final bundle
contains 10,106 inventory entries / 88,671,382 bytes, and its source/artifact and
bundle/inventory digests are in the machine result. Its Docker CLI remains an
empty placeholder: this is successful packaging and admission counterproof, not
execution of a transferred Linux operator binary. The exact owned bundle,
sibling inventory and isolated HOME were removed after verification.

The third managed run passed the complete API/container journey. Its first
status read retained an unknown proposal after the journal confirmation; the
one explicit follow-up returned `confirmed` for the original execution. That
follow-up took 11,338 ms. The bounded registry observations record one
`other-error` followed by `confirmed`; no raw exception is retained and a
specific underlying exception is not claimed. All effects remained at two
through recovery, disable/re-enable and rollback, then a new separately
confirmed v1 action produced exactly three source rows and three confirmed
journals. Repeated confirmation and status did not add an MCP request or effect.
Normal cleanup removed four containers, three networks, two images and 43
physical state keys; the isolated HOME was removed and caller resources remained.
The launch-time runtime source hashes match the committed implementation.

Independent bounded source review covered the SDK/core/driver, seven producer
scripts, the review corrections, the exact-binding follow-up status branch and
the separate source/payload corruption oracles. No outstanding actionable
finding remained in that scope. This is source review, not human model or
institutional acceptance. Backend build, root types, targeted lint and focused
tests passed during development; the required complete PostgreSQL regression,
exact-head CI and delivery results are separate implementation-PR gates.

The complete independent publisher/artifact delivery and
joined administrator/chat/error/recovery matrices remain required. No browser,
native-device, assistive-technology, model-quality or institutional acceptance is
established by this bounded delivery.
