# Public demo loopback integration transport

The self-hosted demo can route its own plugin, knowledge and Anny mock HTTP
requests to `127.0.0.1:$PORT` while retaining the configured public origin in
the request `Host` header. The runtime image enables this with
`HASI_DEMO_LOOPBACK_TRANSPORT=1`; Vercel and deployments without that explicit
server flag keep the existing transport. The enabled path requires an explicit
valid `HASI_DEMO_ORIGIN` and an integer `PORT` from 1024 through 65535 before
any integration request. Fixed ServiceIT HTML acquisition remains ordinary
HTTPS to its configured external demo host.

The transport accepts only the configured origin and explicit bundled paths:
plugin manifests and MCP endpoints (including the current SDK's
`/.well-known/hasi-plugin.json` routes), action status routes, and Anny mock
paths below `/api/v1/`. It keeps method, body, query, headers, cookies and abort
signal, and rejects redirects. It does not dispatch inside the process or
change plugin validation, source rights, or replay checks. The Node HTTP
response keeps its native empty `Response.url`; the current registry and MCP
client paths do not compare it to the public origin, and the transport does
not synthesize a public URL for it. Node fetch overwrites a custom `Host` with
the loopback authority, so the implementation uses Node HTTP with the
canonical `Host`. It sends `Accept-Encoding: identity` and rejects any encoded
response instead of passing compressed bytes as decoded content.

The baseline was commit `69c87a5d82e320705f0cb398f768a69de9252b00`, measured
with runner SHA
`e3f12fa9bcfad5d380103cd933b37675528cd550767652d44cf4ba4dd48b6b6e` from
19:00:25.673–19:01:26.791 UTC. Five users ran 100 valid samples in each of two
resource batches and two availability batches. Their p95 values were 506.47
and 479.14 ms for resource search, and 508.53 and 454.43 ms for availability.
`knowledge.search` had p95 1,634.99 ms and median 1,420.78 ms (range
1,050.31–1,723.02 ms). The run recorded 500 measurements, 566 HTTP requests,
and zero model calls, then failed fast after its first knowledge batch. Repeat
the external benchmark against a deployment before claiming a public latency
improvement. The run retained no raw JSON artifact or measurement digest.

Focused checks ran on Node 26.11.1; the runtime image is based on Node 24.

Focused checks:

```sh
pnpm --filter @hasi/web^... build
pnpm exec vitest run apps/web/tests/demo-integration-transport.test.ts
cd apps/web && pnpm exec eslint src/lib/server/demo-integration-transport.ts src/lib/server/demo-runtime.ts tests/demo-integration-transport.test.ts --max-warnings=0
pnpm --filter @hasi/web typecheck
```

These checks validate request routing and preserved request data. They do not
measure public demo latency; repeat the external five-user benchmark before
making a performance claim.
