# Protected-history recovery across immutable web images

This operator-only extension of the synthetic held journey exercises the
protected chat routes in existing Linux web images. It does not change a
Coolify deployment, use production state or call a real model provider.
It complements the deployment-controller rollback exercise; it is not evidence
that the public demo exposes the protected TestIdP composition.

Use a clean Linux operator environment, the existing explicitly admitted
loopback `hasi_topology_test` database and a local Unix Docker socket. Set
`HASI_PLUGIN_JOURNEY=1` and `TEST_DATABASE_URL` as in the
[held-journey instructions](plugin-journey-artifacts.md). Supply these trusted
operator inputs before startup:

| Variable | Required value |
| --- | --- |
| `HASI_JOURNEY_WEB_CURRENT_IMAGE_ID` | Full `sha256:` ID of the current locally present HASI web image |
| `HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID` | A distinct full `sha256:` ID of the previous locally present HASI web image |
| `DOCKER_HOST` | Optional explicit local Unix socket; otherwise the default context must resolve to one |

Both images must have the expected HASI source label, full commit revision,
Linux OS and host architecture. Labels are checked assertions, not publisher
attestations. No image is pulled, rebuilt or selected through a mutable tag.
`DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`
overrides are rejected rather than silently ignored. Ports 3001, 3002 and
4100–4103 must be free before startup.

Prepare the backend and reference packaging metadata, then start the fixture:

```sh
pnpm build:backend
pnpm reference:prepare
pnpm journey:serve --web-images
```

This mode cannot be combined with `--managed` or `--optimized`. It holds the
TestIdP, both API replicas, signing material, account authority, model fixture,
database and deployment scope across web-image changes. The budget initializer
runs once at startup and preserves prior usage. The terminal-only commands
`web-previous` and `web-current` stop the exact owned container and start the
admitted image. Browser and plugin input cannot select images or issue these
commands. `stats` reports bounded image/result observations; `quit` performs
owned cleanup and retains the caller-owned database.

The frontend proxy uses fixed loopback targets: pages, assets, `/api/health`,
`/api/chat` and its descendants go to the web image on port 3002; other API
routes go to the held API proxy on port 4100. This preserves actual protected
web handlers despite the public-demo build's absent Next.js API rewrites.
Readiness checks the reported revision, session route, page and authenticated
workspace. A Docker process being alive alone is insufficient.

Each web container runs as UID/GID 1000 with a read-only root, bounded temporary
filesystem, process/memory/CPU limits and no capabilities. Only the generated
public model CA certificate is mounted read-only. It receives no Docker socket,
private-key file or operator credential. The trusted operator itself needs
Docker administration access. When that operator runs in a container, its
`TMPDIR` must be a host-owned directory mounted at the **same absolute path**;
otherwise the daemon cannot resolve the sibling web container's certificate
bind source. The operator must also use the daemon host's network namespace
(`--network host` on Linux): the sibling web image reaches the held API, IdP,
model and proxy through that host's loopback. A local socket alone establishes
neither shared filesystem paths nor a shared loopback network.

On partial startup or failed cleanup, retain the reported recovery directory
and bounded container name, expected owner label, image and verified ID if
available. Restore inspection access before targeted cleanup. Never remove an
object whose full identity and ownership cannot be established; do not use
global container pruning as recovery.

Qualification must create results through actual authenticated chat/read
handlers, save the workspace and reload it under current → previous → current
images. Compare retained database/session/budget identities separately from
rendered cards and next-model context. Row retention alone does not prove that
an image can read or safely reconstruct protected history. Use distinct
post-format images when assessing the current format; this mode adds no legacy
proof verifier or compatibility guarantee for older formats.
