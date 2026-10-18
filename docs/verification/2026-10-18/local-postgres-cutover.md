# HASI local PostgreSQL cutover — 2026-10-18

Fabian authorized moving the demo database to the existing Hetzner server and
deleting Neon after verification. This follows the public-demo hosting cutover;
it does not close institutional M3 gates.

## Transfer and preservation

The source was PostgreSQL 18.6, approximately 8 MB, with one application table
(`public.hasi_state_v1`) and only the built-in `plpgsql` extension. PostgreSQL
18.6 now runs as `hasi-database-64vadvq4uowpfrr9l0rlrcg1` in the HASI Coolify
resource using the pinned official image. The persistent volume is
`64vadvq4uowpfrr9l0rlrcg1_hasi-postgres-data`, mounted at `/var/lib/postgresql`.
The `hasi` database owner is not a superuser and cannot create databases/roles
or replicate. The Compose first-boot initialization was separately tested on a
disposable clean tmpfs volume, including application-role table creation.

The sole application writer was stopped for the final custom-format dump.
Source access used TLS hostname/certificate validation with the host CA bundle
mounted read-only into the disposable client. All **201 rows** were restored,
including production/preview namespaces, JSON values, revision UUIDs and expiry
timestamps. Deterministic comparison of every row matched the source before
restarting HASI. A second restore into a separate database matched too; that
temporary database was removed. No empty state replaced the imported budget.

Coolify's hidden `DATABASE_URL` and encrypted exec-only `HASI_DATABASE_URL` in
fnox now reference the private container hostname and restricted application
role. Runtime inspection confirmed this connection, no database host ports,
no database proxy router and only internal/private resource networks.
The generated Coolify service directory/environment permissions are `0700`/`0600`.

## Runtime verification

- The 30-request HTTPS smoke passed authentication/origin checks, explicit mock
  Anny consent, all 43 resource fixtures, synthetic knowledge search, source
  delivery and restricted-source/admin denial.
- Booking preview, explicit confirmation, replay/idempotency, reload and
  separately confirmed cancellation passed against local PostgreSQL.
- Two real model calls passed: Groq GPT-OSS 120B (2,640 input / 25 output tokens)
  and manually selected GWDG Qwen (3,497 / 13). Groq remains the default.
- Both budget rows survived. Conservative charges advanced from **12,529** to
  **17,591 micro-USD**, and reservations from five to seven. The shared USD 1/day
  policy remains; the ledger was not reset.
- A second non-model workflow confirmed signed login, account consent and a
  canceled booking after restarting **both PostgreSQL and HASI**.
- Fresh-resolver public HTTPS returned 200 from `2.28.199.98` with valid TLS
  after deleting Neon.

## Backups and retirement

The final source dump was age-encrypted directly into an operator-only file on
the Mac. The new systemd timer creates daily encrypted dumps on the host with
about 14 days retention. Manual runs succeeded with exit status zero, and a
post-validation encrypted local-database snapshot was copied to the Mac too.
No private age key is stored on the server. The dump content was restore-tested
before encryption; decryption recovery from an encrypted artifact and ongoing
off-host replication/failure monitoring remain open.

Only the unconnected HASI Neon resource `hasi-demo` (`store_qxuElo07f941QXEx`)
was deleted. The CLI confirmed deletion; a fresh lookup reported no resource and
the account-wide resource list retained the other projects' resources.
Vercel hosting and the HASI Neon resource are retired. Automated source-qualified
deployment remains separately tracked in [#79](https://github.com/metaneutrons/HASI/issues/79).
