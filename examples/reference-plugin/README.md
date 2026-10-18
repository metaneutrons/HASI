# Reference v2 plugin artifact

This synthetic plugin exists only for local lifecycle qualification. It declares a public `label` configuration field, the scoped `reference.account` identity claim, and three tools: `read_status`, `prepare_mark`, and `execute_mark`. The execute handler increments an in-memory counter and performs no external action.

`scripts/package-reference-plugin.ts` creates a self-contained runtime artifact. It includes the built HASI SDK and its production dependency tree under `vendor/plugin-sdk`, a license inventory, the exact manifest digest and a SHA-256 inventory of every payload file. Packaging uses the repository's locked pnpm graph in offline mode and skips package lifecycle scripts.

The generated artifact starts with Node.js and the server environment values `HASI_REFERENCE_PLUGIN_TEST_MODE=1`, `HASI_REFERENCE_PLUGIN_TOKEN`, `HASI_REFERENCE_PLUGIN_PUBLIC_KEY`, and `HASI_REFERENCE_PLUGIN_PORT`. It serves `/healthz` and the MCP endpoint. The SDK rejects requests over 64 KiB and bounds tool output to 64 KiB. Its execution journal is process-local and exists only for this synthetic fixture; it is not suitable for plugins that perform real writes. The fixture binds loopback during local qualification; an operator container can bind `0.0.0.0` on its isolated plugin network.

The qualification script copies source into fresh temporary repositories, packages both versions independently, and starts each package from its own directory. It never installs from a plugin-controlled registry, executes a plugin lifecycle script, or accesses an external business service.
