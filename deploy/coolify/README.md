# HASI demo stack for Coolify

The deployment uses two independent raw Compose resources so the synthetic wiki
can start without waiting for HASI credentials. Deploy `compose.wiki.yml` for
MediaWiki. Deploy `compose.hasi.yml` when its required HASI values are
available in Coolify. Both target the existing Coolify v4.4.6 server on
`linux/amd64` and attach their routed service to the external `coolify`
network.

HASI uses the existing production Neon database and the `production:v1`
namespace. The shared budget ledger is retained. Fabian approved a new demo
secret on 2026-10-18; existing signed test sessions will not survive the move.
These files create no HASI database and do not delete the old test records.

## Images and secrets

The server must already have the images loaded locally.
`compose.hasi.yml` defaults to `hasi:demo-selfhost` and
`compose.wiki.yml` defaults to `hasi-mediawiki-demo:amd64`. Both use
`pull_policy: never`, so a missing local image fails deployment instead of
silently pulling another image. The MediaWiki image is built for `linux/amd64`
from [`deploy/mediawiki`](../mediawiki/README.md). MariaDB uses the pinned
`lts` digest in the wiki Compose file.

Set these HASI environment variables in Coolify and mark the credentials as
secrets:

- `DATABASE_URL`: the existing production Neon URL.
- `HASI_DEMO_SECRET`: the separately provisioned, server-only demo secret.
  A new value was approved for this move; old signed test sessions are discarded.
- `GROQ_API_KEY` and `GWDG_API_KEY`: existing provider credentials. Empty
  values leave the corresponding provider connection unavailable.

The HASI Compose file sets `HASI_DEMO_MODE=1`,
`NEXT_PUBLIC_HASI_PUBLIC_DEMO=1`,
`HASI_DEMO_ORIGIN=https://hasi.metaneutrons.cc`, and
`HASI_DEMO_STATE_NAMESPACE=production:v1`. The public `NEXT_PUBLIC_` flag must
also be present when the prebuilt Next.js image is built because Next.js can
inline public variables at build time.

Use [`configure-selfhost-secrets.sh`](../../scripts/configure-selfhost-secrets.sh)
in an interactive local terminal to enter only `GWDG_API_KEY` into an encrypted,
exec-only fnox entry. An existing GWDG entry is preserved. Vercel refuses to
export this sensitive value through `env run`, so the operator must supply it
from the original credential custody. The new `HASI_DEMO_SECRET` is generated
separately from 32 cryptographically random bytes and stored in encrypted,
exec-only fnox and Coolify's protected variables. Groq uses `GROQ_API_KEY`,
which is already held in fnox and is also provisioned in Coolify. Do not echo
them, put them in command arguments, write them to repository files, or include
them in logs. Keep the existing database URL and namespace; do
not provision an empty replacement store or reset the budget ledger. The wiki
Compose resource has no dependency on these HASI variables.

Before deploying the wiki, create three nonempty, root-owned host secret files
with mode `0600`:

| Host file | Mounted in | Purpose |
| --- | --- | --- |
| `/data/hasi/secrets/wiki-db-password` | `wiki`, `wiki-database` | MariaDB `wiki` user |
| `/data/hasi/secrets/wiki-db-root-password` | `wiki-database` | MariaDB root initialization |
| `/data/hasi/secrets/wiki-admin-password` | `wiki` | Initial `wikiadmin` account |

Compose mounts these files under `/run/secrets`; their values do not appear in
the Compose file. The image reads the administrator password only during its
first installation. Changing the file later does not rotate an existing wiki
account or database credential. Retain the wiki config and database volumes
together.
Keep each Coolify service work directory root-owned with mode `0700` and its
generated `.env` at `0600`; recheck permissions after configuration changes.

## Routing and network boundaries

Neither Compose resource publishes host ports. HASI routes through Traefik on
the external `coolify` network to internal port 3000. Its `host-gateway`
mapping sends origin-pinned internal MCP requests for
`hasi.metaneutrons.cc` through the same Traefik router while public DNS remains
unchanged; TLS hostname verification stays enabled. The wiki routes to internal
port 80 and has a Traefik IP allowlist for the campus, specified host
addresses, loopback and the existing Coolify network. The allowlist does not
set a forwarded-header trust strategy. Its source-range check is a network
restriction; synthetic wiki audience labels do not establish source ACLs or
grant HASI retrieval access.

The external Docker network must be the existing `coolify` network with
`10.0.1.0/24` and `fdbc:1a9f:69f8::/64`. The submitted Compose attaches MariaDB
to the internal `wiki-backend` network. Coolify also adds its private per-resource
bridge to both wiki services; it does not publish a database port. Inspect the
rendered Compose before starting a resource. Coolify prefixes the volume names
with its resource UUID, so use the rendered mount names for backups and recovery.
Wiki configuration, uploaded images and the database persist in these volumes.

The separately managed [`proxy.yml`](./proxy.yml) is the persistent Coolify
proxy configuration. It is managed through Coolify's supported proxy
configuration API, publishes HTTPS on host port 443, and configures the
`hasi-dns` Cloudflare DNS-01 resolver. These Compose files only add HTTPS
routers for that resolver. They do not publish host port 80 or change DNS.
The resolver reads its token from `/data/hasi/secrets/cloudflare-dns-token`;
the encrypted operator copy is `HASI_CLOUDFLARE_DNS_TOKEN` in fnox. The token
is restricted to this zone and the server's public IP addresses and expires
on 2027-10-18; replace it before expiry to preserve certificate renewals.

Copy [`rate-limits.yml`](./rate-limits.yml) into the proxy's watched
`/data/coolify/proxy/dynamic/` directory. It replaces the Vercel-only edge
admission control on this host: inference POSTs share a host-scoped token bucket
with a sustained rate of 60 requests per ten minutes and a burst of ten.
Timestamp POSTs use a separate per-IP bucket with the same sustained rate and
a burst of twenty. These limits do not replace the durable USD 1/day model
budget. No forwarded-IP headers are trusted. Keep this file when upgrading or
recreating the proxy; a direct application host port would bypass it.

Resource limits are 768 MiB for HASI, 512 MiB for MediaWiki and 512 MiB for
MariaDB, leaving headroom on the 4 GB host. HASI and MariaDB have Compose health
checks. MediaWiki inherits its local API health check from its image. Services
use restart policies, persistent named volumes and graceful stop periods.

## Synthetic wiki seed and limits

Generate an XML import from the checked-in fictional fixture with
[`scripts/export-demo-wiki.ts`](../../scripts/export-demo-wiki.ts). The export
contains 63 pages: 30 Service-IT documents, 30 Intranet documents, the `HASI
Demo` landing page and two inventory pages. Import the generated XML with
MediaWiki's maintenance `importDump.php` command, then set
`MediaWiki:Mainpage` to `HASI Demo`. The MediaWiki image configures `/` and
`/wiki/` to open that landing page. After CLI imports/message edits, restart
the wiki container to clear its in-process APCu message cache; verify the
current main page through API site info and read the imported revisions.

All imported documents and audience labels are synthetic evaluation data.
They are not university source records, identity attributes or authorization
rules. The HASI chat remains fixture-backed unless a knowledge-source
integration is separately configured and qualified. Wiki network restrictions
do not by themselves approve source access for HASI.

## Rollout evidence, 2026-10-18

The synthetic wiki is running on the new server with a valid DNS-01 HTTPS
certificate. All 63 seed titles and three sample current revisions were
verified from the server, and API site info resolves `HASI Demo` as its main
page. Requests outside the allowlist returned HTTP 403 over both IPv4 and IPv6;
spoofed forwarding headers and a request through ZeroTier were also denied.
An affirmative request from the HsH campus network remains to be checked there.

The host firewall permits public TCP 443 and ICMP only. SSH is reachable over
the authorized ZeroTier connection using the operator's Ed25519 key; the
temporary public SSH exception was removed after that path passed verification.
Coolify management remains bound to loopback and accessible through an SSH tunnel.

HASI is running on the server. The GWDG key was transferred from fnox and
verified against its hidden Coolify value. Groq remains the default; both
providers completed real chat requests and produced the expected Anny tool
call for an individual workplace in building 1J. The HTTP smoke also passed
explicit mock-account consent, source access, booking confirmation/replay and
confirmed cancellation. The signed session and canceled booking survived an
application-container restart using the retained Neon store.

`hasi.metaneutrons.cc` now has DNS-only A/AAAA records for this server. IPv4 and
IPv6 HTTPS checks passed. At the operator's request, the Vercel `hasi` project
and its deployments were deleted after cutover. The Neon `hasi-demo` database
was disconnected from that project and retained; the server still uses it.
Vercel is no longer a rollback target. The new demo key deliberately invalidates
the previous test sessions.
The chat has not yet been switched to MediaWiki-backed retrieval.

The raw Compose resource currently uses a preloaded image. Restarting it does
not fetch a new Git commit. Deleting the Vercel project also removes its project
deployment integration; automatic deployment of qualified `main` changes needs a
separate Git-backed Coolify build/trigger before it can be claimed operational.
Container release publication remains governed by Release Please.
This delivery follow-up is tracked in [#79](https://github.com/metaneutrons/HASI/issues/79).

See the [cutover verification](../../docs/verification/2026-10-18/selfhost-cutover.md).
