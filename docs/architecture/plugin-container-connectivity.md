# Controlled container connectivity

Date: 2026-10-19. The paired Docker driver and fixed-target relay are implemented.
The packaged-reference-plugin qualification passed on local macOS with Colima
and on Linux amd64 Docker 29.9.1. Production gateway integration and broader
release acceptance remain open. See the
[qualification record](../verification/2026-10-19/plugin-relay-feasibility.md)
and the [paired-driver evidence](../verification/2026-10-19/plugin-paired-driver.md).
This status does not change the P5/P6 acceptance criteria.

## Measured problem

Docker 29.9.1 on Linux retains requested `HostConfig.PortBindings` for an
internal-only bridge but does not create an effective `NetworkSettings.Ports`
mapping. The server returns HTTP 200 inside its container; the host cannot
reach the requested loopback port. A normal-bridge control returns HTTP 200 on
the host. See [the measured record](../verification/2026-10-19/reference-portability.md).
Giving the executable plugin an unrestricted network would remove an existing
trust boundary and is not the repair.

## Paired platform relay

The driver keeps a candidate unpublished on a dedicated internal bridge for
its staging generation. The candidate has no Docker port binding. Its
`PluginContainerLaunchPolicy.ingress` records the literal `127.0.0.1` host
address, host port and plugin service port as relay ingress; it does not mean
that Docker publishes a candidate port. A separate trusted platform TCP relay
joins the candidate's internal bridge and an operator-approved normal bridge.
Only that relay publishes a port, and its effective mapping must be exactly one
literal host-loopback binding.

The relay target is the candidate's freshly inspected internal IPv4 address and
declared service port. The relay does not interpret HTTP, CONNECT, Host headers,
URLs or plugin output as a destination. It makes no DNS lookup and accepts no
caller-selected target. Its fixed-target Node program is pinned by SHA-256
`1ffeaa642833ada48edba7c581ed78e480db370cda216d3f7756cfbe99b3c5cc`; its
cached base image is
`docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
The driver inspects the local image and does not pull it. An operator must make
that exact image available before staging; changing the image or program needs
new qualification.

The relay inherits only the pinned Node image's standard `PATH`, `NODE_VERSION`
and `YARN_VERSION` environment, plus exactly its fixed target address, target
port and listen port; inspection rejects any other environment entry. It
receives no plugin secret, secret reference, Docker socket or host mount. It runs
as UID/GID 65532 with a read-only root filesystem, all capabilities dropped,
no-new-privileges, 250 millicores, 128 MiB memory/swap and 32 PIDs.
The program limits each relay to 16 connections, a 2-second connect timeout,
10-second idle timeout, 30-second connection lifetime and 2 MiB per direction.
These limits have elapsed-time and connection-recovery child-process evidence;
source constants alone are not qualification.

The candidate's internal bridge is operator-provisioned for one deployment
generation, isolated with Docker's IPv4 `gateway_mode_ipv4=isolated` setting,
and empty before staging. Inspect both network membership sets: the internal
bridge contains only that candidate and its paired relay, while the relay's
normal bridge contains platform relays owned by the same operator. The `hasi`
labels are ownership metadata, not substitutes for inspecting actual Docker
settings, container identity, network membership and effective port mappings.
An internal-network flag alone does not prove denial of host services, peers or
DNS disclosure; qualify those paths with controlled positive counterparts.

## Operator configuration, identity and lifecycle

`createDockerPluginDriver` is operator-local composition. Its required
`relayNetwork` option names a distinct, operator-provisioned normal bridge;
`allowedInternalNetworks` lists the approved generation bridges. Each bridge
must be a Docker `bridge` network with IPv6 disabled and the labels
`hasi.managed-by=hasi-docker-plugin-driver-v2` and
`hasi.owner=<operator owner ID>`. An internal bridge must additionally have
`Internal=true` and
`com.docker.network.bridge.gateway_mode_ipv4=isolated`, and must be empty when
staging starts. The relay bridge must have `Internal=false`. The driver rejects
wrong labels, occupied internal bridges, unexpected relay members or any
network metadata that fails inspection. See
[production runtime configuration](production-runtime.md#operator-local-docker-container-composition).

- The candidate plugin ID and release digest remain route authority. A relay
  cannot substitute its own identity or become a candidate in route records.
- Bind each relay to one owner, installation, stage operation, candidate ID,
  release digest, internal network, target address and ingress port. Inspect
  actual settings and effective publication; labels or requested settings alone
  are insufficient.
- Preserve the gateway's authentication, fixed-path, bounded-body/response and
  literal-loopback restrictions. Resolve only a freshly verified candidate/relay
  pair and retain the route fences before dispatch. Ordinary registry endpoints
  cannot select this privileged transport path.
- Stage failures and lost replies may leave a partial pair. Reconciliation must
  identify that operation's pair before retry or cleanup. Ambiguous observations
  remain `unknown`; the driver does not infer success, create a second pair or
  delete a same-name orphan with missing or changed ownership metadata.
- Cleanup checks ownership and active-route fences, removes the relay before
  its inactive candidate, and is safely repeatable after interruption. A
  candidate without a relay is incomplete, not healthy.
- Update and rollback retain the previous immutable artifact/configuration while
  checking current trust, rights and secret revisions. A rollback never restores
  revoked authority. A relay program/image revision is a platform input that
  also needs compatibility qualification.

## Qualification status

The relay child-process suite has passed 16 tests, including fixed-target byte
forwarding, invalid-target and port rejection, connection and byte limits,
actual connect-timeout recovery, actual 10-second idle expiry and actual
30-second lifetime expiry while traffic continues. Local macOS/Colima and Linux
amd64 Docker 29.9.1 qualification exercised the new Docker driver with the
packaged reference plugin. On both platforms the native MCP read and driver
health check passed, the candidate was unpublished, the relay exposed only its
loopback port without credentials, a normal-network public-health control
returned HTTP 200 while the plugin request was denied, and cleanup restored the
owned container inventory. The [Linux report](../verification/2026-10-19/plugin-paired-linux-result.json)
and [paired-driver record](../verification/2026-10-19/plugin-paired-driver.md)
contain the platform-specific evidence.

These local results do not establish integrated production gateway traffic,
update/rollback or process-replacement recovery, independent artifact
distribution, complete P5/P6, actual-device behavior or institutional M8
acceptance. The older Linux minimal-HTTP feasibility experiment remains a
separate, narrower record of the original networking behavior.
