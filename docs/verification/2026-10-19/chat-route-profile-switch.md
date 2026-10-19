# Chat route profile-switch policy composition

Date: 2026-10-19. Technical P3-A1 evidence; not complete M2 or model evaluation.
Baseline: `255afe8876eb46685d005a1fb6cee4856cdb48fb`.

`apps/web/tests/chat-route-policy.test.ts` invokes the actual exported chat
`POST` with three successive turns of one conversation. It retains the actual
chat access, production request composition, evidence handling, authorized tool
loader, chat handler and model router. An in-memory fetch fixture supplies the
core session/catalog responses and records provider requests. Only budget
admission is replaced with a no-op reservation; all credentials are synthetic.
There is no HTTP listener, external request, actual model generation or database.

Two explicitly selectable tool-capable profiles are allowed to receive the
host-provided public and confidential classification. Both return 200 with the
selected profile, and the second provider request retains the preceding user
and assistant messages. Each turn receives a different current approved tool
descriptor; the second outgoing schema excludes the first descriptor.

The third selectable profile permits only public context. With the same complete
host classification it returns the routing-policy 403, without a third provider
request or budget reservation. All three turns refresh the session and tool
catalog. This positive/denial pair checks route composition, not a fake model's
resistance to prompt injection or the upstream API's behavior.

Root reviewed the test and added explicit retained-message and policy-error
oracles. On Node 24, this test and the existing handler suite pass **13 tests
in two files**. The full web TypeScript check passes. The staged-file lint hook checks this test through its own project-aware
configuration; the standalone root ESLint selection does not cover it. Required
exact-candidate CI remains a delivery gate. Runtime source classification and institutional approval remain separate.

Independent static review found no concrete blocker. Its explicit limitation is
that the synthetic session/catalog endpoints do not validate the forwarded
cookie or implement the core API actor-authorization decision. The test proves
fresh catalog consumption by the route; those upstream authorization controls
retain their separate API tests.
