# Concurrent plugin configuration across API processes

Date: 2026-10-21. Bounded M2 P6-A2 technical qualification, not milestone or
institutional acceptance. Git HEAD was `a7653f736ea91f816a0657654f84f16d1501ae7a`;
the eight API/store/SDK source identities in the record match that tree. Unrelated
Anny presentation/parser work in the shared checkout did not change these inputs.

## Actual observation

The frozen one-off driver starts two distinct API OS processes, separate pools,
one uniquely owned loopback PostgreSQL 18.6/arm64 instance and one synthetic MCP
plugin. API test personas supply admin/student controls; they do not represent
institutional authentication. No provider, institutional service or business tool
is called. No application code change was needed: the existing HTTP routes enforce
expected-revision comparison against the shared store.

Both replicas first read revision 1. Simultaneous draft updates submit that same
expected revision with different synthetic labels. Exactly one returns HTTP 200;
the other returns 409 with the specific parallel-configuration conflict. Both
read revision 2 and the same winning draft; no activation has occurred. Two
simultaneous activations from revision 2 again return one 200 / one 409, then both
read revision 3, activeRevision 1 and the same accepted active label.

A test-only PostgreSQL BEFORE UPDATE delay on this owned settings row makes
overlap observable. The observer sees both distinct API application names and a
database lock wait during each race; simultaneous HTTP promises alone are not
the concurrency oracle. This artificial delay is not a performance measurement
or a production database change. Unauthenticated admin reads return 401; a
student draft write returns 403 and leaves the accepted configuration unchanged.

[The allowlisted result](p6-configuration-race.json) records process, image,
source, conflict/convergence and exact-owned cleanup identities. The temporary signing key,
plugin server, API processes, observer pool, container and network are stopped
or removed. [The root invocation record](p6-configuration-race-invocation.json)
independently observes process exit 0 and verifies the result/source hashes.

## Provenance and limits

Authoritative root-observed run: `08424c83-129d-4682-b5ac-c455afc5c9b0`.
Result SHA-256: `ebbebd8c177497c1253c89ae44609d6bbb703514fcb171a17b70cc8f339198e1`.
Frozen driver SHA-256: `dfaf9def8621aef754e239ddbb51877dfe5a1f7b105cf0e78fe9e0ed22e22845`.
Input packet SHA-256: `65575c97fba7a74e1334ac909f6cef901a0ca1114ce82276e73ab071fda9b576`.

[The frozen input packet](p6-configuration-race-inputs.tar.gz) preserves the
original local driver and instructions, including original absolute checkout
paths. It is an observed one-off qualification input, not a supported portable
operator CLI or new CI requirement. Replay on another machine requires explicit
path/dependency adaptation and a new result identity. The observed root run uses
Node 24 with an isolated HOME and explicit existing local Docker socket; it does
not retrieve model/service credentials. Real TestIdP/SSO and other runtime lifecycle
scenarios remain separately mapped evidence.

An earlier worker summary named a different run from the artifact left on disk.
That ambiguous provenance is not used here. The primary agent froze its inputs,
then performed the root-observed run above. Its first isolated-HOME startup could
not discover the Docker context and failed before APIs started; it is excluded.
After explicitly selecting the existing local socket, the recorded run exits 0
and verifies cleanup. The accepted result is frozen rather than overwritten by
further exploratory invocations. No production state, sessions or budget counters
were touched.
