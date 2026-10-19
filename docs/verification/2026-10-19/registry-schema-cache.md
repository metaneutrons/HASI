# Reuse compiled tool output validators

Date: 2026-10-19. Baseline `c4c55efc9506b8bbfc273101baff80b20c2d3cfb`.
This is a bounded compiler optimization, not an API performance pass, source-rights
acceptance, model quality result or provider prompt-cache measurement.

Durable registry refresh reconstructs fresh manifest/schema objects after signed
state validation. Input and execution-result checks already use `validateSchema`,
which keys compiled AJV validators by the canonical schema-content digest. The
ordinary tool-output path instead called `validator.validate` with each new
schema object. AJV could compile identical approved schema content repeatedly.

The ordinary output path now uses that same existing digest-keyed helper.
Every output is still checked, including object shape and size. Actor/account,
installation/configuration, source rights and replay checks are unchanged. Only
compiled validation programs are reused: result bodies, identity, source access
and authorization decisions are never cached by this change. No manifest, tool
contract, stored-state format, model profile or credential changes.

## Bounded compiler probe

[The recorded measurements](registry-schema-compilation.json) use the actual
`knowledge.search` output schema and a valid synthetic document. Three paired
trials on each of Node 24.21.0 and 26.11.1 validate 100 freshly cloned schema
objects. Each iteration accepts the valid result and rejects an added forbidden
field. The cached mode includes canonical schema-content hashing. Both modes
use the same strict AJV options and formats as the registry, without network or
provider calls. The result artifact records the probe hash and schema digest.

This isolates compiler reuse and preserves the invalid-output countercase. It
is not a registry-request benchmark or a memory profile; the public five-user
API measurement must be repeated after deployment before claiming the 1s target.
The preceding loopback deployment still failed that target at knowledge.search
p95 1,315.45 ms, despite passing resource and availability batches.

Focused registry, plugin-boundary/lifecycle and knowledge-context regression
checks passed 33 tests across four files. Scoped lint, root TypeScript and
whitespace checks passed. Required full integration CI and post-deployment
performance evidence remain separate.
