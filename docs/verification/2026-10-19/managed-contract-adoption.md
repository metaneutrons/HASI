# Managed active-contract adoption

Date: 2026-10-19. Integration baseline: `afb1cca53b39d76f93172d2ca272b3e338dceded`.
Scope: M2 host/installer integration, not full milestone acceptance.

The production launcher composes a host-only contract reader over the private
signed installer RPC. Requests and responses retain scope, payload, actor and
fresh nonce binding. The fixed runtime subject cannot call admin methods; admin
subjects cannot use that method. A missing reader is an error, not an inactive
contract. Returned manifests and status projections are strict and bounded;
the client rejects another installation, modified digests, undeclared/duplicate
secret statuses and missing required grants.

The worker reads current publisher/catalogue approval, coordinator, route,
signed settings, runtime credential grant and inspected endpoint. It rechecks
those authorities before returning the active contract. The host adopts the
contract independently of its signed connection baseline and compares the active
configuration revision. It does not receive plugin secret values or references.
The transport credential remains separately configured at the API and worker.
Rotation of that transport requires their operator configuration to agree;
the reader does not convey a replacement credential.

The registry and gateway tests use actual loopback HTTP, two separately running
synthetic MCP versions, valid invocation signatures and a simulated trusted
route resolver. They exercise an approved major/permission change without host
restart, native reads, registry reconstruction from durable connection state,
missing authority and later fresh recovery, stale and wrong installation or
package identity, missing grants, configuration disagreement and a route-only
replacement. An unrelated MCP source continues to work during managed authority
failure. A removed connection is not restored. Proxy positive/counterchecks
count actual upstream calls: missing/stale lifecycle fences make no call, an
exact fence passes, and the control header does not reach the plugin.

The worker setup test uses real PostgreSQL and private HTTP but intentionally no
Docker socket. Its inactive-contract result and restart/setup boundary are not
an active Linux worker lifecycle qualification. The native registry/gateway test
likewise does not establish Docker isolation, independent artifact distribution,
institutional authorization or real-device acceptance. Source delivery of the
preceding PR #101 is tracked separately in #49/#47.

Explicit pending-action invalidation status and immutable invalidation audit,
actual deployed Linux managed install/update/recovery, external artifact
acquisition/inventory, capability review presentation and remaining P5/P6
matrices remain open. Real institution, participant and device acceptance stays
M8. No provider call, business write, budget reset, container publication or new
paid resource is part of this qualification.
