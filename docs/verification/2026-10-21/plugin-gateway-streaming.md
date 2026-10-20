# Bounded private-gateway SSE transport

Date: 2026-10-21 (Europe/Berlin). Related to #49 P5/P6 and technical M7 #54.
Candidate base: `57fd09ec3e0d160dc05f73503c1d099adc6d50a8`.

## Reproduced failure and repair

Before the repair, the actual SDK test established a sessionful MCP connection
through the unchanged gateway, negotiated `2025-11-25`, then failed because its
tool returned `isError: true` after waiting for its custom server-to-client
request. The gateway buffered the SSE request until the tool timed out. This
observed pre-fix test failed in 2,589 ms; it is a counterprobe, not a latency
benchmark. The initial test later received a cleanup-only assertion change.

With the repaired gateway, the same tool receives one host response and returns
`synthetic-state`. This uses actual Fastify/Node HTTP listeners, the pinned
2.3.1 MCP SDK, an actual Client and NodeStreamableHTTPServerTransport, and a
concurrent HTTP response through the gateway. The fixture explicitly selects
the existing sessionful protocol to exercise bidirectional transport. The
application's default protocol negotiation and stateless SDK composition are
unchanged.

## Local qualification

Node24 focused run: **12 passed, 2 files, 320 ms**.

```sh
pnpm exec vitest run tests/plugin-deployment-proxy.test.ts packages/plugin-sdk/tests/gateway-stateful-mcp.test.ts
```

The actual HTTP/fetch cases observe the first SSE frame while its source is
still open and complete a concurrent POST. Countercases enforce a configured
byte cap, a total deadline despite continuing heartbeat traffic, downstream
cancellation, an upstream abort after headers, and gateway shutdown. Each failure
case verifies the upstream close effect
before ordinary test teardown. An invalid upstream port proves synchronous
request-construction failure returns HTTP502 and leaves the gateway closable.
For the deliberately destroyed upstream, downstream read rejection is the
meaningful assertion; upstream close itself is expected.
Existing fixed-path, authentication, redirect/header and lifecycle-fence cases
remain in the suite.

Backpressure uses `write`/`drain` to pause and resume the upstream. The forward's
timer/listeners and shutdown registration remain until downstream completion.
A real Node HTTP listener with a controlled 1 KiB writable high-water mark
produces observed drain events while the client receives the complete 512 KiB
payload byte-for-byte. This exercises actual backpressure without faking the
write result. It does not measure production slow-client throughput or memory
bounds, Linux/Docker relay or multi-replica session routing behavior.
No live provider, user account, business action, credential or production change
was used by this focused run.

Root TypeScript and affected lint checks are separate development gates;
mandatory pre-push, hosted exact-head CI and delivery must also pass before
integration. Their results belong to the PR and milestone tracking.

## Scope

The callback is a transport-only synthetic fixture. It does not authenticate a
state caller or implement state persistence, actor/account scoping, migration,
execution receipts, managed v1-write/v2-read/rollback, independently distributed
artifacts or browser/mobile acceptance. Storage foundation PR #165 and this
repair are prerequisites, not completion of M2/M7.

## Source identities

| File | SHA-256 |
| --- | --- |
| `apps/api/src/plugin-deployment-proxy.ts` | `1fe882fbf9db9e53461e87f89bec1efe6d18479a1c6b7c3802cf4b3b3a382f2f` |
| `tests/plugin-deployment-proxy.test.ts` | `0241eb41cf9543bb56ff435474336ad898b2ab27741e422f8f87083015229abb` |
| `packages/plugin-sdk/tests/gateway-stateful-mcp.test.ts` | `ffedc9a1c61f2953600bab3c6aab01ae14a377ac29f789d41049eaf6a05c7e92` |
