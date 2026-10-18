# Self-hosted demo cutover — 2026-10-18

The public HASI prototype now runs on its own Hetzner server under Coolify.
This is a synthetic-demo hosting qualification, not institutional M3 acceptance.

## Runtime and credentials

- Coolify 4.4.6 manages separate HASI and MediaWiki Compose resources.
- The existing production Neon connection, `production:v1` state namespace and
  shared `model-budgets:shared:v1` ledger are retained. No budget reset occurred.
- A new 32-byte demo secret was explicitly approved by Fabian. Previous signed
  test sessions are intentionally invalidated; stored test records were not deleted.
- `HASI_DEMO_SECRET`, `GROQ_API_KEY` and `GWDG_API_KEY` are held in fnox and
  hidden Coolify variables. Exact stored equality was checked inside the server;
  no values or credential fingerprints were emitted.
- Images were built locally for `linux/amd64` and loaded on the server. This
  did not publish a GHCR image or create a release.

## Live checks before DNS cutover

Thirty HTTP requests passed against the new IP with the public Host/SNI and
normal TLS verification. Cookies remained in test-process memory. Coverage:

- anonymous denial, explicit mock login and personal Anny-account consent;
- Groq as default, both provider profiles configured, same-origin/input checks;
- 37 individual workplaces and six meeting rooms, including building 1J;
- synthetic knowledge search, document/source delivery and restricted-source denial;
- a booking proposal, explicit confirmation, idempotent replay and reload;
- a cancellation proposal that leaves the booking active until separate confirmation;
- mock-administrator plugin access and the public-demo browser-storage boundary.

The session, account consent and canceled booking were then read successfully
after restarting the HASI container. This checked durable state independently
of the initial application process.

Four real model calls passed through HASI's chat API and its shared budget:

| Provider/profile | Case | Input tokens | Output tokens |
| --- | --- | ---: | ---: |
| Groq `groq-oss-120b` | Short German response and signed timestamp | 2,640 | 17 |
| GWDG `gwdg-qwen3-30b` | Short German response and signed timestamp | 3,497 | 13 |
| Groq `groq-oss-120b` | Workplace-search tool call for building 1J | 2,655 | 57 |
| GWDG `gwdg-qwen3-30b` | Workplace-search tool call for building 1J | 3,515 | 29 |

Both tool-call probes selected `anny_search_resources`, `kind: workplace` and
location `1J`; the accompanying catalog requests succeeded through the MCP path.
These are focused integration probes, not a comprehensive model evaluation.
GWDG's approved temporary price estimate remains unchanged.

## Network and admission checks

- Public DNS now resolves the HASI hostname to the new server's A and AAAA records.
  The old CNAME was snapshotted before a Cloudflare batch mutation and the new
  records were read back. Resolver caches can retain the previous Vercel answer
  for its remaining TTL; both origins were left available during propagation.
- New-origin HTTPS returned 200 over IPv4 and IPv6 with certificate verification.
- Public firewall ingress remains TCP 443 and ICMP only; management uses ZeroTier.
- The wiki still denies outside IPv4/IPv6 requests and spoofed forwarded headers,
  including clients using ZeroTier. Server-local HTTPS succeeds. Campus-positive
  verification still requires an actual HsH client.
- Traefik now provides separate inference and timestamp token buckets, because
  the application's Vercel WAF integration is inactive off Vercel. A counter-probe
  produced ten unauthenticated 401 responses followed by three edge 429 responses;
  profile GETs and timestamp admission remained independent. No model was called
  by that probe. The durable USD 1/day ledger remains a separate admission gate.

The updated container-smoke script now performs explicit synthetic account
consent after each persona login; previously it failed against the M2 account
boundary. Shell/Node syntax, the two focused namespace/export suites (14 tests)
and whitespace checks passed.

## Remaining boundaries

The knowledge chat still reads the synthetic fixture repository; hosting the
63-page synthetic MediaWiki does not itself wire that adapter into chat or
qualify access to actual HsH sources. Institutional identity, source rights and
owner acceptance remain separate open gates.

Public-demo chat histories remain browser-local and account-scoped. Production
OIDC chat persistence is a different route and is deliberately unavailable in
this demo mode.

The current Coolify service uses a preloaded image. Automatic source builds and
main-merge deployment to this host are not yet qualified. After cutover, the
operator requested deletion of the Vercel `hasi` project. Its Neon `hasi-demo`
resource was first disconnected and retained. The CLI confirmed project
deletion, a subsequent inspection returned `project_not_found`, and the Neon
resource remained available with no connected Vercel project. Fresh-resolver
HTTPS still returned 200 from `2.28.199.98`; signed mock login, explicit account
consent and database-backed booking reads passed after deletion. Both providers
remained configured; these checks made no additional model calls. Vercel is no
longer a deployment or rollback target. Release Please is unchanged.
PR 78 remains the review location for the M3 candidate; this
deployment does not imply that its institutional milestone is closed.

The source-build/main-deployment follow-up is tracked in
[#79](https://github.com/metaneutrons/HASI/issues/79). The retained budget ledger
reported USD 0.012529 in conservative admission charges after the four probes,
against its USD 1 limit, with no unresolved or unknown-usage reservations.
This is admission accounting, not an invoice measurement.
