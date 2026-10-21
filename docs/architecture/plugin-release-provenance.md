# Authenticated plugin release provenance

Managed executable releases use the publisher-facing
`@hasi/plugin-sdk/releases` subpath. This contract is independent of the host API
implementation. An approved Ed25519 publisher signs a schema-version-2 envelope
with domain `hasi-plugin-release-v2\0`. The signature authenticates the exact
plugin/version, manifest digest, immutable image reference, configuration schema,
migration declaration and complete `provenance` object.

## Publisher assertions and image binding

`provenance` contains the source repository URL and full Git commit, artifact
payload SHA-256, root license, and a nonempty package/version/license inventory.
Inventory entries have a unique name/version identity and canonical ordering;
the SDK factory sorts entries and rejects duplicates. The inventory is bounded
to 1,000 entries and the canonical provenance to 256 KiB of UTF-8. Parsed source,
inventory entries and inventory arrays are frozen, so later mutation cannot
change the authenticated nested data.

Repository URLs are canonical HTTPS or local file URLs without credentials,
queries or fragments. They are assertion metadata, never fetch destinations.
Local qualification records the actual fixture Git commit and file URL rather
than inventing a remote origin or using a content digest as a Git identity.
External artifacts retain their supplied source assertions. Neither a source
URL nor an operator sidecar establishes publisher trust.

The publisher/build pipeline follows this order:

1. Produce and review the payload, manifest and package/license inventory from
   the intended source commit. Use `createPluginReleaseProvenance` to validate
   and canonicalize the inventory.
2. Call `pluginImageProvenanceLabel` with the plugin ID, version, manifest digest
   and provenance. Embed its exact returned `sha256:` digest of the canonical record in the image's
   `org.hasi.plugin.provenance.v1` label before building the image.
3. Compute the final immutable image digest. Sign
   `pluginReleaseSigningBytes(unsignedEnvelope)` with the approved Ed25519 key
   and encode the signature as unpadded base64url. The host separately enforces
   semantic version and operator-approved image-registry policy.
4. Supply the envelope and reviewed manifest through the operator's approved
   catalog. Admit the image to the local daemon through a separately reviewed
   delivery process; the host neither pulls arbitrary images nor executes
   repository installation/build scripts.

The fixed 71-character image label hashes the complete canonical record and
fits the existing bounded container-label contract. Full provenance remains in
the signed envelope. The label omits the final image digest to avoid a circular
build input.
The envelope includes that digest. Before resolving plugin secrets or creating
any container, the driver inspects the exact locally available digest and
requires byte-for-byte equality between its image label and the authenticated
release identity/provenance. Missing, altered, rebound or noncanonical labels
fail closed, including when a publisher validly signs different metadata for an
old image. Existing filesystem, network, nonroot, seccomp and resource bounds
remain independent gates.

Administrator license and inventory-digest fields derive from the verified
release, not unsigned catalog lookalikes. The inventory digest covers the whole
provenance object, including source and payload identity. Existing stage,
compatibility, review, active-revision and recovery controls still apply.

This proves authentication and binding of a publisher's assertion. It does not
prove that the declared commit reproducibly builds the image, that the inventory
is complete or that an approved publisher is honest. Independent artifact/key
delivery, source review and the joined update/rollback qualification remain
separate P5/P6 acceptance evidence.

## Pre-release contract transition

Version-1 release envelopes are rejected; there is no compatibility signature
path. Remove the old unsigned `license` and `inventoryDigest` catalog fields,
rebuild images with the canonical label, sign version-2 envelopes and obtain
fresh operator approval. Do not relabel an old digest or treat its old approval
as approval of a new release.

Stored coordinator state is not reset or silently upgraded. A legacy stored
envelope fails validation and needs an explicit operator migration/reapproval
before that installation can be managed. Preserve its state, receipts and audit
evidence. Database, chat-session and budget storage are not migrated by this
contract change. A rollback target also needs a currently approved version-2
envelope, matching image label and compatible configuration/state; retaining an
old version-1 image alone does not make rollback valid.
