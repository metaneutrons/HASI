# Reference v2 plugin artifact

This synthetic plugin exists only for local lifecycle qualification. It declares a public `label` configuration field, the scoped `reference.account` identity claim, and three tools: `read_status`, `prepare_mark`, and `execute_mark`. The execute handler increments an installation-, subject- and account-scoped synthetic counter and performs no external action.

`scripts/package-reference-plugin.ts` creates a self-contained runtime artifact. It includes the built HASI SDK and its production dependency tree under `vendor/plugin-sdk`, a license inventory, the exact manifest digest and a SHA-256 inventory of every payload file. Packaging uses the repository's locked pnpm graph in offline mode and skips package lifecycle scripts.

The generated artifact starts with Node.js and the server environment values `HASI_REFERENCE_PLUGIN_TEST_MODE=1`, `HASI_REFERENCE_PLUGIN_TOKEN`, `HASI_REFERENCE_PLUGIN_PUBLIC_KEY`, and `HASI_REFERENCE_PLUGIN_PORT`. It serves `/healthz` and the MCP endpoint. The SDK rejects requests over 64 KiB and bounds tool output to 64 KiB. Set `HASI_REFERENCE_STATE_FILE` to an absolute private SQLite file outside the artifact directory to retain its SDK journal, invocation replay records, source receipts and counters across restarts or artifact changes. Node.js 24 provides the SQLite runtime; no database dependency is installed. Without that variable, state is deliberately in memory and cannot prove restart recovery. This example remains a synthetic fixture, not a production business adapter. The fixture binds loopback during local qualification; an operator container can bind `0.0.0.0` on its isolated plugin network.

The qualification script copies source into fresh temporary repositories, packages both versions independently, and starts each package from its own directory. It never installs from a plugin-controlled registry, executes a plugin lifecycle script, or accesses an external business service.

Managed containers receive `HASI_PLUGIN_INSTALLATION_ID` from the trusted Docker
driver. The fixture passes that ID to the SDK's `acceptedInstallationIds`; a
correctly signed invocation for another installation is still unauthorized.
Standalone fixture processes without that variable accept only the manifest ID.


The held `pnpm journey:serve` launcher always uses a private file outside both
versioned artifacts and exposes fault controls only through its owned IPC channel.
`reference-drop-reply` discards a confirmed HTTP response; `reference-lose-ack`
commits the synthetic effect but leaves the SDK journal unknown. Read-only source
reconciliation can recover the latter. `reference-source-unavailable` and
`reference-source-available` control the synthetic source resolver. These controls
are never HTTP routes, model tools or client input. SIGTERM closes SQLite and the
server, then disconnects the owned IPC channel. Source receipts and journal
records have no automatic expiry because removing an idempotency record could
repeat an effect; this disposable fixture has no production retention policy.
