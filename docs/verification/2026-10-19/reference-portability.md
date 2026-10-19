# Reference qualification portability repairs

Date: 2026-10-19. Integration baseline:
`8a9a2ef8599ceecbbef9f958a39d2d474845627f`. Scope: reference artifact packaging
and disposable Git fixture isolation under M2 #49. This does not accept P5/P6.

## Git hook and worktree isolation

The reference qualifier creates, commits and updates its own temporary Git
repository. Previously those commands inherited the caller's `GIT_DIR`,
`GIT_WORK_TREE`, index and configuration settings. In a managed worktree's
pre-push hook, `git init` consequently targeted the parent repository and changed
its `core.bare` setting. The setting was restored to `false`; normal primary and
managed-worktree status checks then succeeded.

Qualification Git commands now receive only a small environment allowlist,
disabled terminal prompts and explicitly disabled global/system configuration.
They discover their repository from the supplied temporary working directory.
Plugin child processes retain their existing separate synthetic environment.

`tests/reference-plugin.test.ts` runs the complete existing install, configure,
read, confirm, update and rollback journey while inherited Git variables point
at a different disposable repository, index, global config and template. It
compares that foreign repository's complete contents and modes before/after,
checks its clean status, and restores the caller's original Git environment.
The focused test passed locally on Node v26.11.1 (one case, 6.50 seconds).

## Mode-bound archive portability

macOS-created symbolic links can have mode `0755`; Linux archive extraction
exposes symlink mode `0777`. The artifact verifier correctly rejected the
different mode because the artifact digest binds actual file kinds, modes,
sizes, contents and link targets.

Packaging now normalizes the link itself to `0777` on macOS before recording
the digest, re-reads its metadata and fails if normalization did not succeed.
It does not follow the link, change its target's permissions, rewrite an
existing manifest or ignore modes during verification.

A newly prepared reference artifact contained 161 links, all mode `0777`.
An independently copied tree passed the unchanged verifier; a modified
`src/server.js` was rejected before any Docker lookup. The transferred Linux
tree passed verification of all 10,091 inventory records, including bytes,
modes and link targets. Artifact identities:

- Payload: `b500d737a0a3890a992e13837c4f5d38e6c7a80c35b9afcb2f70af53a77f0de4`.
- Artifact manifest: `a46f5bc1c4c99fc47cb917f3d07e4890281de3624a4148c0966e17f0be276383`.
- Plugin manifest: `5cbee0101afb557940503dea42ebb8af228caafd6386942a50002d1d298be8b4`.
- Reference source: `4911e8c6281f37bd2d79e849b92163fd1181641d43e1893a81fff69b79427f35`.

The artifact has 8,301 payload files/links and 72 runtime packages. These
identities describe the measured preparation, not an external publisher release.

## Linux execution remains unaccepted

The separate synthetic Linux amd64 experiment used Docker 29.9.1 on Ubuntu
24.04.5 and a cached digest-pinned Node base. The plugin process ran and returned
HTTP 200 inside its container, but its requested host-loopback health path was
unreachable. The experiment exited unsuccessfully with
`host_loopback_health_path_unavailable`; zero native MCP reads executed.
The driver retained its internal-network, non-root, read-only filesystem,
capability-drop and resource restrictions. No confinement control was relaxed
to obtain a positive result.

A separate minimal Docker comparison reproduced the cause with the same cached
Node image and server: both containers returned HTTP 200 internally. On the
internal bridge, `HostConfig.PortBindings` retained the requested loopback port,
but `NetworkSettings.Ports["3000/tcp"]` was `null` and a direct host HTTP request
failed. On a normal bridge, the effective mapping existed and the direct host
request returned HTTP 200. The probe bypassed HTTP proxies and removed both
owned containers/networks. A requested mapping is therefore not evidence that
Docker actually publishes it on this platform. A controlled connectivity design
must preserve plugin network isolation rather than attaching the plugin to an
unrestricted bridge.

Owner-scoped plugin/control container, network and image cleanup passed. The
trusted operator container/image and temporary transfer route/listeners were
also removed. No business action, real model request, production database change,
budget reset or public artifact release occurred. Healthy execution, actual
gateway/update/recovery, independent distribution and full P5/P6 acceptance
remain open.
