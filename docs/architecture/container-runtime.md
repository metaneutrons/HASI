# Container runtime

The container build produces a self-contained HASI prototype image. It builds
the web app with Next.js standalone output and serves its API and MCP routes
from the same origin. The standalone build includes the workspace root and the
two checked-in demo fixtures. Ordinary Vercel builds keep their existing Next.js
output because standalone mode is enabled only for this container build.

The image deliberately uses the explicit demo identity flow. It does not
provide university SSO, real user authorization, live Anny access, production
room availability, or real bookings. Room names and catalog metadata are from
the checked-in snapshot; identities, availability, booking state, and knowledge
sources are synthetic. The image is suitable for local evaluation and prototype
deployment, not as a production university service.

## Build

The builder installs the exact workspace package manager, pnpm 12.11.2, without
Corepack and runs the web production build. The Node 24 Bookworm slim base uses
the official multi-platform index digest
`sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
The index was inspected and contains both `linux/amd64` and `linux/arm64/v8`.
No server secret is a build argument or build environment variable. The image
does not contain model-provider credentials. Supply `GROQ_API_KEY`,
`GWDG_API_KEY`, or the custom connection's `CUSTOM_API_KEY` only at runtime;
`CUSTOM_ENDPOINT` and `CUSTOM_MODEL_ID` are runtime settings. These values stay
server-side. Configuring a provider does not verify a live model connection.

Build and tag locally for the host architecture:

```sh
docker build -t hasi:local .
```

To build one release architecture explicitly, add `--platform linux/amd64` or
`--platform linux/arm64`.

## Local Compose demo

The Compose example uses the same pinned Postgres 18.6 image digest as CI. It
keeps PostgreSQL inside the Compose network and publishes HASI only on the
host's loopback interface. The host port is also the app's internal port so the
origin-pinned demo integration calls return to the same container.

Create a private local environment file with fresh values. The database
password is URL-safe so it can be used in `DATABASE_URL` without encoding
changes. The script refuses to overwrite an existing file and does not print
the generated values:

```sh
node --input-type=module <<'JS'
import { closeSync, openSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const path = ".env.container-demo";
let fd;
try {
  fd = openSync(path, "wx", 0o600);
} catch (error) {
  if (error.code === "EEXIST") {
    throw new Error(`${path} already exists; preserve it or choose another path.`);
  }
  throw error;
}
try {
  writeFileSync(
    fd,
    `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\n` +
      `HASI_DEMO_SECRET=${randomBytes(32).toString("base64url")}\n` +
      "HASI_IMAGE=hasi:local\n",
    "utf8",
  );
} finally {
  closeSync(fd);
}
console.log(`Created ${path} with private permissions; values were not displayed.`);
JS
docker compose --env-file .env.container-demo -f compose.demo.yaml up -d
```

If port 3000 is occupied, add a free port such as `HASI_DEMO_PORT=3187` to
`.env.container-demo` before starting Compose. The Compose file derives `PORT`,
the published port, and `HASI_DEMO_ORIGIN` from the same value. The example
defaults to the local `hasi:local` build. To use a release image after one is
published, change `HASI_IMAGE` in the file to its explicit GHCR version tag.

Open `http://127.0.0.1:3000` (or the selected port) and choose one of the
explicit demo identities. The configured `HASI_DEMO_MODE`, `DATABASE_URL`,
`HASI_DEMO_SECRET`, and `HASI_DEMO_ORIGIN` are required at runtime. The secret
must be a fresh 32-byte base64url value; do not reuse an institutional or model
provider credential. `GROQ_API_KEY`, `GWDG_API_KEY`, and `CUSTOM_API_KEY` are
optional runtime credentials and remain server-side. `CUSTOM_ENDPOINT` and
`CUSTOM_MODEL_ID` configure a custom connection. Supply these through a private
environment source before running Compose; configuring them does not establish
that a provider connection works.

To stop the demo while keeping local demo state, run:

```sh
docker compose --env-file .env.container-demo -f compose.demo.yaml down
```

The database volume is persistent. Remove it only when the local demo state
should be discarded:

```sh
docker compose --env-file .env.container-demo -f compose.demo.yaml down --volumes
```

## Local smoke check

The backend-only smoke script uses Node built-ins and a loopback URL. It checks
anonymous denial, explicit student and admin personas, the 30-room fixture
(including 37 individual workplaces, six meeting rooms with person capacities,
and desk-to-office relationships), synthetic knowledge search,
student access denial, admin retrieval, a single confirmed room booking after
confirmation replay and reload, disabled-plugin enforcement, and logout. It
creates a fresh demo workspace in the configured database and uses only the
checked-in synthetic room and knowledge fixtures.

```sh
BASE_URL=http://127.0.0.1:3000 node scripts/container-smoke.mjs
```

The script accepts the loopback URL as its first argument instead of `BASE_URL`
when preferred. It does not exercise the browser UI or make a model-provider
request.

## Release qualification and first publication

Release Please owns every version tag and GitHub release. Merging ordinary
changes to `main` creates or updates its release PR; it does not publish a
container. Leave that PR open until a versioned release is intended.

A maintainer can exercise the native `linux/amd64` and `linux/arm64` build,
PostgreSQL smoke flow, SPDX SBOM, keyless archive signature and GitHub
provenance without publishing an image:

```sh
gh workflow run release.yml --ref main -f qualification_only=true
```

This route uploads CI artifacts only. Its `-pipeline.N` label is not a Git tag
or a GitHub Release. It does not contact GHCR or access the release App secret.
A green qualification run proves the payload jobs, not the complete public
registry or Release Please publication path.

The first actual Release Please publication still needs operator observation.
GHCR may create a new package as private even when its source repository is
public. HASI requires anonymous pull before stable promotion. If this gate
fails, preserve the existing immutable version tags and staged GitHub
prerelease. Do not delete/recreate tags, overwrite payloads or rerun the entire
workflow blindly. Record the failed run, source SHA, release ID, uploaded asset
checksums and exact registry digests. An operator must establish public package
visibility, then use GitHub Actions **Re-run failed jobs** on the original run.
The image-publishing job reuses an architecture tag only if its registry digest
matches the signed OCI archive. It reuses a version index only after checking
both platform digests and its exact readback digest. Existing tags with different
content are rejected, never overwritten. Signatures, provenance and anonymous
pull are checked again before promotion. Do not dispatch a new complete release
run: its initial gate deliberately rejects already-published candidates.

Failures during asset upload or draft readback need separate reconciliation:
compare the retained CI artifacts with every existing remote asset before any
manual repair. The workflow refuses to clobber uploaded assets. A green native
qualification run does not verify this first-publication or recovery path;
those remain gates for the first requested Release Please release.

The workflow never promotes a partially verified candidate. Runtime updates
should select the verified image digest and preserve a compatible database
backup; changing an image alias alone is not a database rollback.

The source OCI archives retain their BuildKit provenance/SBOM descriptors and
are signed as exact archive bytes. GHCR architecture tags use explicit
platform-only pushes of the qualified leaf manifests. The final two-platform
index receives its own GitHub provenance and keyless cosign signature. Stable
publication uses one global workflow lock and checks release ordering before
promoting GitHub latest status or mutable registry aliases.
