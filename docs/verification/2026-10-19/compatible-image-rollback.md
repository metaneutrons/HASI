# Compatible core image rollback and rollforward

Date: 2026-10-19. M7 operational exercise using synthetic demo state.
This is an image recovery exercise, not complete M7 or institutional acceptance.
The disposable demo has no backup/restore acceptance requirement under Plan V5.

After PR #114 exact-main CI and automatic deployment completed, the application
served `255afe8876eb46685d005a1fb6cee4856cdb48fb`. Before the exercise,
controller admission was persistently disabled and verified inactive/disabled;
its existing journal was preserved and its latest automatic job was completed.
Both selected revisions understand the signed lifecycle epochs and terminal
proposal invalidation. No pre-floor image was used.

Retained compatible images were inspected before the operation:

| Revision | Retained immutable image ID |
| --- | --- |
| `b53701abe4b5cd0bb51c3ef1f67ad7ca8a76d4cf` | `sha256:9b39587597f3e526ef04ac973afedf3101ef74fdfe6e906c17c4c77a3a1f32ad` |
| `255afe8876eb46685d005a1fb6cee4856cdb48fb` | `sha256:df4442dc993b39c5b9fa5f8e4f312e969363d2c8090f82f5f030a850a271497f` |

The installed Coolify API's rollback request contract was inspected directly.
A bounded operator helper called only that fixed application's endpoint with
the exact allowed commit. The existing deployment credential remained inside
the server process and was neither returned nor passed in arguments.

- Rollback job `bdhoq9qgmf2tpf8ux624heq3` finished at b53701a,
  `2026-10-19T15:02:28Z`. Public HTTPS reported ready at that exact revision;
  the sole matching running application container was healthy with the b53701a
  image tag. The retained floor image identity was inspected before rollback;
  this record does not claim a separate running-container image-ID readback
  before rollforward.
- Rollforward job `9mxmvss9uiy0pncuo6dlpx7r` finished at 255afe8,
  `2026-10-19T15:04:27Z`. Public readiness returned that exact revision.
  Running container `af645671d4ae5b4333c1a3ae895978f1a7cb292a575154f64a67ff5f2e2eb528`
  was healthy and its actual immutable image ID matched the inspected current
  image above. No rebuild or registry publication was requested.

A root-only, content-free DB fingerprint baseline at `15:01:23.454 UTC`
contained 185 active row identities/revisions/value digests and one budget row.
Post-rollback comparison at `15:02:51.301 UTC` and post-rollforward comparison
at `15:05:04.939 UTC` each found all 185 still-valid rows present and unchanged,
with no expired baseline rows. The PostgreSQL container and persistent volume
remained identical. The budget fingerprint at all three points was
`f41601fe2bec9119dca2ecd4946a782caf6ea0e177423ba18e6ba5ac7ad9eca1`.
No row values, credentials or prompt contents were emitted by the checker.

The already authenticated public browser reloaded after each transition and
retained the controlled conversation, last search's four workplace cards plus
three more results, and its invalidated historical proposal. Two chat sessions
were retained. No confirmation or model request was issued during this exercise.
These are preserved synthetic fixtures, not proof of a live institutional write.

The controller resumed with its existing journal and was verified active/enabled.
No DB reset, secret/namespace rotation, budget bootstrap, old grant restoration,
backup removal, volume replacement or pre-epoch writer was used.
The independent monitor, complete connection-loss/uncertain-action journeys,
other milestone prerequisites and final M7 acceptance remain separate.
