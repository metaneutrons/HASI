# Admin UI repeated-feedback latency evidence

**Capture date:** 2026-10-21  
**Recorded base commit:** `f55d20ed809ef4e6015abf5ccda3774af34c71b8`  
**Machine-readable result:** [admin-repeated-feedback-result.json](./admin-repeated-feedback-result.json)  
**SHA-256 of machine-readable result:** `5c3d3bfb82ca78eb560a77632ead7e25979de78eadb84c4d9b404c4ebf4867e0`

This report records the supplied completed browser capture. The measurement covers optimized, actual HASI admin React components in a production, minified React 19.3.1 / React DOM 19.3.1 bundle, rendered against an in-memory loopback API. It does not establish provider, plugin-process, installer, database, or full-application latency. The capture recorded zero provider calls.

## Results

The capture contains 125 sequential records: 122 valid app passes, one invalid app attempt excluded for instrumentation interference, one passing normal control, and one delayed control rejected by the 200 ms gate. The status totals are 123 PASS, one INVALID, and one FAIL.

Samples 1–21 used a 390 × 1600 viewport. Samples 1–20 opened the configuration disclosure and passed. Sample 21 was an attempted checkbox interaction. Locator autoscroll placed its linked app-owned change marker behind the measurement overlay, so the instrument could not establish a valid result. This is an invalid measurement, not a product defect, and it is excluded from the app pass count.

Samples 22–125 used a 1280 × 1800 viewport. The table summarizes app passes only; the checkbox count excludes sample 21. Timings are rounded to 0.1 ms.

| App feedback | Passes | Median (ms) | Maximum (ms) |
| --- | ---: | ---: | ---: |
| expand config | 20 | 13.1 | 13.6 |
| checkbox | 21 | 17.8 | 19.0 |
| edit field | 20 | 12.6 | 16.7 |
| feedback busy | 41 | 10.8 | 16.6 |
| feedback error | 20 | 20.1 | 21.6 |

The pending-feedback group used a 120 ms mock-server delay. The error-feedback group used a 0 ms mock-server delay; its measured time includes the immediate loopback HTTP request. A normal DOM control measured 9.8 ms and passed. A deliberately delayed control configured with a 250 ms DOM delay measured 262.1 ms and failed the 200 ms gate, showing that the gate rejected the intended slow countercase.

The full sanitized observation sequence, including every ID, category, status, viewport, and timing, is in the JSON result. The one invalid sample has no elapsed time.

## Fixture state and limits

The final fixture snapshot recorded 42 catalog reads, one configuration read, and 61 draft-save posts: 41 saved and 20 server errors. It recorded zero activation, staging, review, release-activation, status-read, and unknown-route calls. The pending and error delay settings above are phase-specific; the final fixture snapshot is the error phase with a 0 ms delay.

This is a bounded rendered-UI feedback measurement against synthetic loopback behavior. It does not measure a live provider, an installed plugin process, a database, an installer, or a complete deployed application.

## Source and artifact bindings

The five application source digests match the named files at the recorded base commit. The two SDK entries match the local compiled `dist` JavaScript files actually imported by the harness; these generated artifacts are not tracked source files.

| Fixture key | Repository-relative artifact | SHA-256 |
| --- | --- | --- |
| `managedPluginPanel` | `apps/web/src/components/managed-plugin-panel.tsx` | `fb076f836b31fd772e124530f568305d00beae1865e71de669876351afeec315` |
| `managedPluginPanelCss` | `apps/web/src/components/managed-plugin-panel.module.css` | `3aef417d53bd8ce21ab643e6515700a67a2a2e47d4858738efca967d8e3c2553` |
| `pluginConfigPanel` | `apps/web/src/components/plugin-config-panel.tsx` | `8460b9e3a3490867bddf382125e99e39b0ec5f33ef34ea6e58ebe60454d1372c` |
| `pluginConfigFields` | `apps/web/src/components/plugin-config-fields.tsx` | `93e01ae80c4fcffa271d4e6ac57791dd90d8251a4e20a6fbe2313587b117f4e9` |
| `pluginConfiguration` | `apps/web/src/lib/plugin-configuration.ts` | `59c34ebff7a3c4097585666c76dafeecc774801f64eeac88f467e1332549700b` |
| `pluginSdkDeploymentAdmin` | `packages/plugin-sdk/dist/deployment-admin.js` | `1e268687eed70ad8af455521d08d05aaad5262e679fe6b03dbaa99f989b73f83` |
| `pluginSdkConfiguration` | `packages/plugin-sdk/dist/configuration.js` | `5a1bc8124d4f0930f614d84f8ceedc4528cb8abea237c72440a80c333580cf3c` |

Harness inputs and generated bundle digests recorded by the fixture:

| Harness source | SHA-256 |
| --- | --- |
| `entry` | `32034c498ae3d0a0e108878e619a099f707fa3c11aedf2c9f30df5b008a8a5b6` |
| `latencyInstrument` | `5592aeb689c211d422685c1e24acfeba9978a3ac936ebb71327b5e1e8054e491` |
| `server` | `b89b55dfc0e85d9f0b9b6b64e507307cdf02b4ae6f1c524445e22fcdc689e674` |

| Production bundle file | SHA-256 |
| --- | --- |
| `bundle.js` | `a953a9ab7baf3277639ba3769ba185b32bac19b4eb20621a7af7a64d4fada00c` |
| `bundle.css` | `0d4f068505de226482d5ceff3bc5eb08faf59a79576a19b3a1414b31d6453cb1` |

Global CSS has a separate source-to-compiled binding. The source digest recorded at capture is `c4b822edf2602132fa5e3fd4d11ed81c1f669079b80eb7daf9cc46ef21ccae17`; the compiled asset `17biss_iokrrj.css` has digest `8c9813f4472b43c268a7b4741ab9bba06c5f21c53ccbc8a2c9ec32637787bdba` and matches the generated CSS file. The recorded base commit's global CSS source digest is `9bc838264d5950faa1d8ba72e359b1f1bbdbdbea0048ea563b5d1b714c611ece`. The compiled asset contains `.welcome-lede` with `color: var(--muted)`, while the later source contains the separate color-only change to `color: var(--ink-soft)`. The capture therefore used compiled CSS from before that edit; this report makes no blanket claim that all latest source CSS was rebuilt for the capture.

The three supplied input JSON files are bound by these SHA-256 digests:

| Input file | SHA-256 |
| --- | --- |
| `results.json` | `20837e8fada3bf1e19200698427fb387455837f51f4b62fd7d61c33dcc7036c0` |
| `summary.json` | `542c6f78872355e6b57a3bb5a95d3101cda5295c5685e147eddc94a978144979` |
| `fixture-state.json` | `090f26b3dba993aae861292d1a89a894272e816b8c7213a2766b736d3878baa3` |

No additional test or server run was performed while producing this report.
