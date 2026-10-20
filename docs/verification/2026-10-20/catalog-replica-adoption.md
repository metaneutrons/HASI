# Catalog connection adoption across API replicas

Date: 2026-10-20. Baseline: `a85358e9380e3036333590ccb1d06fffe91e00de`.
Scope: M2/P4/P6 connection and configuration continuity across API replicas.

## Defect and correction

Two already-running API replicas shared the same signing key, scope and durable
store. Connecting an approved ordinary remote plugin on replica A persisted its
signed connection but did not install it on replica B. `refreshAll()` previously
adopted missing managed sources only. The focused regression failed because B
still reported `connected: false`. In the joined local browser composition,
opening the reference plugin configuration then displayed “Dieses Plug-in ist
nicht mehr verfügbar.”

Every replica now adopts missing operator-approved catalog sources from a
verified signed shared connection during refresh. An explicit shared store is
required: approving a catalog entry alone does not connect it in an in-memory
registry. Installation retains the manifest pin, signed lifecycle state,
configuration, endpoint and managed-authority checks. Disabled sources remain
disabled; removal withdraws them before later operations are resolved.

Catalog and ordinary plugin administration now refresh after administrator
authorization, including direct configuration/connection-test entry points.
Keyed personal-account and reviewed App-resource routes also reconcile before
using the local installation. Authentication/administration checks still precede
registry or plugin network work. A removed source now returns 404 on a subsequent
re-enable request because reconciliation has already removed its local entry.

## Evidence and limits

- Seven focused registry cases cover adoption/read/removal, absent local approval,
  wrong signing key, wrong scope, altered signature, disabled adoption and
  approval without a shared store.
- A two-API HTTP regression constructs both APIs before connection, then reads
  configuration on B without first listing/refreshing it. It also tests the MCP
  connection, catalog readback, disable/removal and rejection of anonymous and
  student administrators before registry or plugin I/O.
- The six affected test files pass all 35 tests. Root TypeScript and focused
  type-aware lint pass. The separate delivery record supplies exact-head CI.
- The local joined browser rerun uses TestIdP, two separately running API
  processes, isolated PostgreSQL and a separately packaged reference plugin.
  Connect, open configuration, save a public-label draft, explicitly activate
  revision 1 and test the MCP connection succeed after the correction.
  This local composition is still under development; it is not an accepted P6
  journey or a deployment of arbitrary third-party plugins.
- Personal demo consent succeeded after one status-refresh retry. A later
  reference-tool chat response was redacted during protected autosave. Those
  remaining account/history composition findings are not fixed or accepted by
  this connection-adoption correction. Two local synthetic model requests were
  observed; no real provider requests or institutional writes were made.

M2, M6 and M7 remain open. This regression does not qualify the complete plugin,
mobile/keyboard, evaluation, cache or operational acceptance matrix.
