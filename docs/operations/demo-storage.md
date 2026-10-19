# Demo storage maintenance

The deployment controller uses `statfs` on `/var/lib/hasi-deploy` before its
first Coolify write and again before deployment submission. It waits with
`storage_low` below 8 GiB, or `storage_unavailable` when the filesystem reading
fails or is invalid. Those waiting states remain retryable.

`scripts/operations/demo-storage-maintenance.mjs` runs directly on the Coolify
host as root. It requires the root-owned, mode `0700` state directory and a
root-owned, mode `0600` version-1 controller journal. It rejects symlinked
inputs and holds an exclusive lock at
`/var/lib/hasi-deploy/storage-maintenance.lock`. The controller takes the same
lock around each complete cycle and releases it before polling, so an idle
`authorized` or `pinned` record cannot prevent storage recovery.
The Docker CLI path and commands are fixed. The app image repository is exactly
`tjzdwweelb3zhjtfpgzvjs8k`; tags must be full 40-character Git SHAs.

Run it without arguments first. The default is a dry run, and stdout contains
only a JSON summary of byte and operation counts. With free space below 12 GiB,
`--apply` prunes unused Docker builder cache first, with a 180-second timeout.
If space remains below 12 GiB, it can remove old completed app image tags with
`docker image rm --no-prune`. Before each removal it reloads the controller
journal and every stopped or running container's configured image reference and
actual image ID.

The compatible floor revision
`b53701abe4b5cd0bb51c3ef1f67ad7ca8a76d4cf`, the latest two completed
revisions, every container image reference and image ID, and all nonterminal
journal SHAs are protected. Records in `submitting`, `uncertain`, or `submitted`
skip cleanup while a physical build may be active; `authorized` and `pinned`
records allow maintenance with their SHAs protected. The tool does not remove
volumes, networks, containers, or images from other
repositories. Docker command output is bounded and never printed.

If maintenance cannot restore 12 GiB of headroom, stop the deployment
controller service and investigate host storage before retrying. The controller
itself waits only below 8 GiB, so the operator must hold deployments while free
space remains between 8 and 12 GiB. A stale lock after an abrupt host shutdown
requires operator inspection before removal.

## Host timer installation

Install the script on the host at a root-owned path such as
`/opt/hasi-deploy/demo-storage-maintenance.mjs`, then review a dry run with
`/opt/hasi-deploy/node24 /opt/hasi-deploy/demo-storage-maintenance.mjs`. The host operator
installs the systemd units. The host has no distribution-managed Node runtime.
Provision `/opt/hasi-deploy/node24` from `/usr/local/bin/node` in the existing
controller container only after verifying that container's image uses the
reviewed, digest-pinned Node 24 image in the controller service. Compare the
copied binary's SHA-256 with the container binary, set root ownership and mode
`0755`, and verify its version and script syntax on the host before use. This
avoids an unpinned package download; the host runtime must be refreshed when the
controller image pin changes. Do not copy container environment or arguments.

A oneshot service should run as root with
`ExecStart=/opt/hasi-deploy/node24 /opt/hasi-deploy/demo-storage-maintenance.mjs --apply`.
A timer can use `OnBootSec=15min`, `OnUnitActiveSec=1h`, and `Persistent=true`.
After installation, run `systemctl daemon-reload`, enable the timer, and inspect
its next run and the sanitized service result with `systemctl list-timers` and
`journalctl -u hasi-demo-storage-maintenance.service`.
