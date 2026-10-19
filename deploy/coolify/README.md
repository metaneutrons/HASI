# HASI demo stack for Coolify

Qualified-main delivery is implemented by the private source-deployment
controller and a native Git/Dockerfile application. See
[automatic deployment and rollback](main-deployment.md) for admission, custody,
state preservation and operator commands. The original `compose.hasi.yml` is
the bootstrap stack; after cutover the same data resource uses
[`compose.database.yml`](compose.database.yml) and retains its existing volume.
Qualification status and exact deployed revisions are tracked in #79.

The bootstrap used independent raw Compose resources for HASI and the synthetic
wiki. `compose.wiki.yml` still manages MediaWiki. The native HASI application
builds the public repository Dockerfile; `compose.database.yml` retains its data
service under the original UUID. All run on the existing Coolify v4.4.6 server
on `linux/amd64`. The native app reuses the retained private resource network
already joined by the proxy; the wiki uses the external `coolify` network.

HASI uses a private PostgreSQL 18.6 container and the `production:v1`
namespace. All 201 records from Neon, including the shared budget ledger, were
migrated before the Neon resource was deleted. Fabian approved a new demo
secret during the initial Vercel cutover on 2026-10-18. Subsequent database and
source-deployment changes preserve that secret, signed sessions and test records.

## Images and secrets

The bootstrap stack requires its images loaded locally.
`compose.hasi.yml` defaults to `hasi:demo-selfhost` and
`compose.wiki.yml` defaults to `hasi-mediawiki-demo:amd64`. Both use
`pull_policy: never`, so a missing local image fails deployment instead of
silently pulling another image. The native application instead builds the exact
CI-qualified Git SHA; its secrets are runtime-only variables. The MediaWiki image is built for `linux/amd64`
from [`deploy/mediawiki`](../mediawiki/README.md). MariaDB uses the pinned
`lts` digest in the wiki Compose file.

Set these HASI environment variables in Coolify and mark the credentials as
secrets:

- `DATABASE_URL`: the private PostgreSQL URL using the restricted `hasi` role
  and rendered database container hostname. The encrypted exec-only recovery
  copy is `HASI_DATABASE_URL` in fnox. Never print the URL.
- `HASI_DEMO_SECRET`: the separately provisioned, server-only demo secret.
  Preserve the current value during every deployment and rollback. Rotation
  during the initial Vercel move is historical and must not be repeated.
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
them in logs. Preserve database records and namespaces during migrations;
never reset the budget ledger when changing database hosts. The wiki
Compose resource has no dependency on these HASI variables.

Before deploying HASI, provision the PostgreSQL initialization files:

| Host file | Owner/mode | Source or purpose |
| --- | --- | --- |
| `/data/hasi/secrets/postgres-admin-password` | root `0600` | `HASI_POSTGRES_ADMIN_PASSWORD` in fnox |
| `/data/hasi/secrets/postgres-app-password` | UID/GID 999 `0600` | `HASI_POSTGRES_PASSWORD` in fnox; matches the application URL |
| `/data/hasi/postgres-init/10-hasi.sh` | root `0555` | [`init-postgres.sh`](./init-postgres.sh) |

Keep the host secrets directory root `0700`. The application password file is
read by the PostgreSQL container's UID 999 during first initialization. The
script creates a non-superuser `hasi` login and transfers database ownership;
the runtime role cannot create databases/roles or replicate. Files are mounted
read-only. An existing data volume skips initialization; changing a password
file does not rotate the existing database role. Provision secret values through
protected stdin, never command arguments or repository files. Restore imported
state with `--no-owner --no-acl --role=hasi` before admitting application traffic.

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
HASI's PostgreSQL uses its internal `hasi-backend` network plus the private
per-resource bridge Coolify adds. It has no external `coolify` network attachment,
proxy router or host port; host authentication uses SCRAM. PostgreSQL 18 data
persists at `/var/lib/postgresql`, not the older image's `/data` mount location.

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

Resource limits are 768 MiB for HASI and 512 MiB each for PostgreSQL, MediaWiki
and MariaDB. PostgreSQL uses 128 MiB shared buffers and at most 50 connections.
HASI and both databases have Compose health
checks. MediaWiki inherits its local API health check from its image. Services
use restart policies, persistent named volumes and graceful stop periods.

## PostgreSQL backups and recovery

Under [Plan V5](../../docs/plans/consolidated-delivery.md#demo-continuity-decision--2026-10-19),
the disposable demo has no backup acceptance requirement. The installed mechanism
and historical evidence below do not imply a recovery guarantee. Production
encrypted-artifact restore and ongoing off-host replication/failure monitoring
remain [M8-A8](../../docs/plans/hasi-mvp.md#institutional-acceptance-m8) gates.
After total state loss, keep model admission disabled until the current budget
window has safely elapsed or authoritative accounting has been recovered; never
interpret an empty database as evidence of zero spending.

For production backup setup, or an optional demo backup, install `age` on the
host. Copy [`backup-postgres.sh`](./backup-postgres.sh) to
`/usr/local/sbin/hasi-backup-postgres` (root `0700`) and the adjacent systemd
service/timer files to `/etc/systemd/system/`. Write the public age recipients
from the operator's fnox configuration to `/etc/hasi/backup-recipients.txt`.
Create `/data/hasi/backups/postgres` as root `0700`, reload systemd and enable
the timer. Adjust the unit's container name if the resource UUID changes.

Daily backups run from 03:15 UTC with up to 15 minutes jitter and about 14 days
retention. A consistent custom-format dump streams straight into age encryption;
only a completed file is atomically published. The service returns failure on
pipeline errors. No private decryption identity is stored on the server.
The final source dump and a post-validation local-database snapshot were also
saved to the operator's Mac under `~/.config/hasi/backups/`. Ongoing off-host
replication and failure monitoring are not configured; server-local backups
alone do not survive host loss.

Recover on a trusted workstation using an authorized age identity, then stream
the dump into an empty PostgreSQL 18 database owned by `hasi` with
`pg_restore --exit-on-error --no-owner --no-acl --role=hasi`. Preserve namespaces,
JSON values, revisions, expiries and the complete budget ledger. Stop the old
writer for the final snapshot/cutover and compare all rows before opening traffic.
A separate-database restore passed before Neon deletion; an encrypted-artifact
decryption recovery exercise remains open.

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
application-container restart. After moving to local PostgreSQL, the HTTP
workflows and both real model calls passed again. Signed login, account consent
and a canceled booking also survived restarting both PostgreSQL and HASI.

`hasi.metaneutrons.cc` now has DNS-only A/AAAA records for this server. IPv4 and
IPv6 HTTPS checks passed. At the operator's request, the Vercel `hasi` project
and its deployments were deleted after cutover. The Neon `hasi-demo` database
was subsequently migrated, verified and deleted too. A fresh resource lookup
and account-wide resource list confirmed its removal.
Vercel is no longer a rollback target. The new demo key deliberately invalidates
the previous test sessions.
The chat has not yet been switched to MediaWiki-backed retrieval.

The original raw Compose web service used a preloaded image and could not fetch
new commits. The private controller and native Git application replace that
delivery path; the original resource retains PostgreSQL. Exact runtime,
automatic-revision and rollback qualification is recorded in
[#79](https://github.com/metaneutrons/HASI/issues/79), not inferred from a
restart. Container release publication remains governed by Release Please.

See the [cutover verification](../../docs/verification/2026-10-18/selfhost-cutover.md).
The subsequent [database cutover](../../docs/verification/2026-10-18/local-postgres-cutover.md)
records the Neon retirement and backup checks.
