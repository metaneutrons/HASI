# Independent generic v2 reference plugin

The local qualification completed on 2026-10-18 with HASI Core held open while
a separate Node process served two independently packaged versions of
`hasi.reference`. The qualification used only the reviewed local fixture,
loopback HTTP, and synthetic in-memory action state. It did not call an
external service, LLM, registry, or Docker daemon and did not perform an
external business write.

The qualification's temporary source history recorded initial revision
`479a19032ec72da957b7ec7fdaebc2bd31af384b` with manifest version `1.0.0` and
compatible update revision `d9d2a89ba72db44be2858745f2a544d7fdf1e3c4` with
version `1.0.1`. These temporary Git commit IDs are run-specific; the artifact
and manifest digests below identify the packaged bytes. Each version
was packaged into its own temporary directory before its process started. The
SDK and production dependency closure were bundled into each artifact using
offline `pnpm deploy` with lifecycle scripts and pnpm hooks disabled. The
qualification checked `/healthz`, connected the approved source, activated
configuration, read only the declared account claim, prepared and confirmed a
synthetic action once, and activated the compatible update while Core remained
running.

The package command is:

```sh
pnpm exec tsx scripts/package-reference-plugin.ts /path/to/new-artifact-directory
```

It emits an `artifact-manifest.json` containing the package ID and version,
canonical and raw manifest hashes, SDK/runtime dependency versions and
licenses, and sorted payload file records including kind, mode, size, hash or
symlink target. The artifact digest excludes only `artifact-manifest.json` and
is computed over those sorted payload records. The qualification's evidence
was:

| Evidence | Initial artifact | Updated artifact |
| --- | --- | --- |
| Canonical manifest digest | `5cbee0101afb557940503dea42ebb8af228caafd6386942a50002d1d298be8b4` | `9743655c929142f0150ded13fd71fa94c7279fbb994b652a2b34ea255da206bb` |
| Artifact SHA-256 | `052f65c8f0d811dadf3e263599e07ca2df1d3f7480805fe81156ea63e6473833` | `05c0f535ea5e9f52ca33df4185595e72cbd460d5db9c54dbf54a46d068fc2dc9` |
| Artifact manifest SHA-256 | `ddf84920daed1ede8d8d58db5806627b21fa852a34103c1081315befeab5ab83` | `62cdca0e024dc2dcf800db6cd0b1b9d7d7ae3da68ff1e3c05d613824d0eb2267` |

Both artifacts contained 72 SDK runtime packages and the same exact SDK
license/version inventory, SHA-256
`ab25a0cb985434334806a17a35ad3599642e211b2cdba4c4420c42f764eb9f39`. The
plugin package's own `GPL-3.0-only` record is also included in each artifact
manifest. The initial package had 8,301 payload files; the updated artifact
had the same runtime closure and a distinct complete artifact digest.

The test route controller used two instances over one in-memory store. It
activated the v1.0.1 route, rolled back to the retained v1.0.0 route, and
confirmed the restored process remained healthy. This establishes the fixture
flow and shared-store controller contract only. Focused tests cover CAS
concurrency, stale configuration fencing, gateway authentication/path/header
limits and Docker-label endpoint resolution logic. They do not establish
production PostgreSQL durability or deployment.

The local proxy is implemented as a separate loopback gateway, and the Docker
driver resolves a route to a fresh, verified `127.0.0.1` published port.
Neither the production gateway wiring nor a real Docker container/image was
used in this qualification. Full container hardening, operator shared-store
integration, route switching under actual traffic, and actual-device recovery
remain unverified. The qualification command is
`pnpm exec tsx scripts/qualify-reference-plugin.ts`.
