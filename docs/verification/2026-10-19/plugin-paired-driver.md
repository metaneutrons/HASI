# Paired container driver qualification

Date: 2026-10-19. Integration baseline: `2703005aaf3c420335d0e87a1b4044e254a5a41a`.
Scope: the M2/P5 connectivity repair, using synthetic reference authority and
credentials. This is not complete P5/P6, independent distribution, institutional
acceptance, or an actual-device result.

## Actual runtime result

The healthy packaged reference MCP artifact passed through the actual paired
Docker driver on local macOS/Colima and Linux amd64 Docker 29.9.1. The
[sanitized Linux report](plugin-paired-linux-result.json) records exact artifact,
image, manifest, configuration and relay-program identities. Linux ran a trusted
operator container with the reviewed Docker socket and installed CLI; those
operator privileges were never granted to the plugin or its relay.

Each run verified a publisher signature against a synthetic key, the running
manifest, health and one native MCP read carrying the expected synthetic actor
context. The plugin was non-root, read-only (`EROFS` on a write attempt), without
capabilities, with no-new-privileges/seccomp and measured cgroup CPU/memory/PID
limits. Only assigned synthetic credential slots were present. Its requested and
effective published ports were empty; it had only its isolated internal bridge.
The separately inspected relay had exactly its two intended networks, the pinned
program/image, only its public target settings and one effective `127.0.0.1` port.
A public-health probe returned 200 from the normal-network control and failed
from the plugin. This is evidence for that path, not general DNS/peer isolation.

The qualifier restored the complete before/after container inventory and removed
its own networks/image. The separate stopped Linux operator container and its
local image were removed after checking exact image/owner/state, as were the
transferred temporary payload and transfer listener. The Linux report remains
under the operator-owned `/var/tmp/hasi-plugin-qual-paired-ZXws1P/` directory.
No production database, budget, real provider request or business write changed.

## Transfer and operator identity

The portable package's 10,091 entries were verified after transfer: file bytes,
mode, symlink targets and exact inventory membership. The final stricter qualifier
used a two-file script/inventory update over the previously verified synthetic
artifact, then reverified the complete reconstructed package against its new
inventory before adding the installed CLI. Python's restrictive tar
filter initially normalized directory modes; re-extraction of the exact verified
archive restored the recorded modes before verification and execution. The
production artifact verifier was not changed to accept that mismatch.

- Transfer archive SHA-256: `688ff876c99ea6f8a68a99317895c6fad887fec2988751a9aa814279050c6220`.
- Initial inventory file SHA-256: `bd0857a0890052c0968b0ef1486cae82582984709ccfcf790afe8bb57d9d7f01`.
- Bundled qualifier SHA-256: `40fcd8c88863d4d0db4eb279969c4b2fa03c05c5349675de7a14e4cda349e335`.
- Installed Linux Docker CLI SHA-256: `84a8553077099a6a56b5ec36651dc17f5a1b89c26e33971e02906818c2f2626d`.
- Installed buildx SHA-256: `5d20d03c2f9bfe7cbb249ee7ae75c4a77904a111e38ff1f7bccc317cb675c483`.
- Disposable operator image: `sha256:1b5f546f234db81675192c1a6b2509f0dfa23aa1bafa7dfbcab22dac4ba8f846`.

The blank CLI placeholder was replaced only after verifying the installed binary;
ELF format checks alone are not a trust decision. No image was published. SSH
observation timed out, but a subsequent exact-container inspection reported
`exited`, exit 0, and the complete saved report was retrieved in bounded output chunks and checked; no
second run was started to replace the lost observation. A temporary diagnostic
MTU host route was removed and its absence verified. The later stricter-probe
run was intentional requalification after review changes, not a retry of an
unknown operation.

## Development gates and limits

Independent static review found and corrected the deterministic-name orphan
fence, the overly narrow foreign-environment probe and loss of the primary
error category during cleanup failure. The final qualifier checks the complete
process environment key set, rejects unassigned secret/provider keys using
counterprobes, and rejects MCP tool-error results. Its tightened local and Linux
runs both passed; focused independent re-review found no remaining actionable
issue in those paths.

The 34 driver cases cover pair identity, effective port/network tampering,
foreign target/entrypoint/environment, changed relay IDs, lost create/start
replies, occupied generation networks, repeat cleanup and deterministic-name
orphans hidden by label filters. The relay's 16 child-process tests also cover
elapsed connect/idle/lifetime expiry and connection-slot recovery. The connect
case uses a test-only unconnected socket, not an external network blackhole.

Full local PostgreSQL regression passed **860 tests in 95 files**, after supplying
the unchanged, hash-verified ignored Anny OpenAPI snapshots required by the
existing mock test. Backend build, root/web typechecks and affected lint pass.
A clean-worktree frontend lint exposed a dot-directory omitted from TypeScript's
wildcards; the explicit `.well-known` source include restores checking without
excluding the route. Hosted exact-candidate CI and main delivery remain separate.

Run the local behavioral qualifier with explicit opt-in:

```sh
HASI_DOCKER_QUALIFY=1 pnpm exec tsx scripts/qualify-healthy-plugin-container.ts
```

Prepare the self-contained operator inputs separately:

```sh
pnpm exec tsx scripts/package-healthy-container-qualifier.ts
```

Preparation verifies opt-in/context guards, a valid copied artifact and a corrupted
payload countercase before Docker executable lookup. The full driver run uses an
in-memory route controller; it does not prove actual gateway activation, durable
update/recovery/rollback, externally reviewed source distribution, all P5/P6
countercases or M8. Those criteria remain open.
