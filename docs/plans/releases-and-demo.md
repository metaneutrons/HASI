# Demo and container delivery

Date: 2026-10-16. Updated: 2026-10-18. D1/D2 record historical README and Vercel acceptance. Current source-qualified delivery to the self-hosted demo is tracked separately in #79. Versioned container releases remain Release Please-only, with Linux amd64 and arm64 support. Delivery does not declare the institutional MVP complete.

Tracking under adopted V3: [unified delivery index #47](https://github.com/metaneutrons/HASI/issues/47), [D1 #15](https://github.com/metaneutrons/HASI/issues/15), [D2 #16](https://github.com/metaneutrons/HASI/issues/16), [D3 #17](https://github.com/metaneutrons/HASI/issues/17), and current source deployment [#79](https://github.com/metaneutrons/HASI/issues/79). Requirements live here; implementation stages and evidence belong in the linked work issues. The former delivery index [#14](https://github.com/metaneutrons/HASI/issues/14) transfers to #47 as `not_planned`; preserve its historical D1/D2 record and open #17/#79/#81 pointers before closure. This transfer does not accept D3, #79 or #81.

## Current deployment state — 2026-10-18

The public demo runs on Hetzner under Coolify, with private PostgreSQL 18.6. The Vercel project and Neon database are retired. The current Coolify service uses a preloaded image; automatic source builds and CI-qualified main deployment remain open in [#79](https://github.com/metaneutrons/HASI/issues/79). Use that issue for source pinning, authenticated trigger, state/budget preservation, health checks, unauthorized-trigger rejection and rollback evidence. Do not build or deploy an older main revision over the current candidate.

The cutover, database migration and their limits are recorded in [self-host verification](../verification/2026-10-18/selfhost-cutover.md) and [PostgreSQL cutover verification](../verification/2026-10-18/local-postgres-cutover.md). These establish synthetic-demo hosting and preserved state, not institutional source rights or M3 acceptance. Encrypted-backup restore and ongoing off-host replication/monitoring remain open operational work.

### Historical D2 evidence

Main `319ac132181ae64f37960b7e9953652fbe31e904` and later exact-main deployments were used to accept D2 under [#16](https://github.com/metaneutrons/HASI/issues/16). This was Vercel delivery evidence for its stated revisions. The Vercel project is now deleted; D2 remains historically closed and does not describe the current runtime. Its acceptance criteria below are retained as the original record, not a live deployment instruction.

## Milestones and acceptance authority

### D1 — README and branding

Status: accepted historically in [#15](https://github.com/metaneutrons/HASI/issues/15).

- D1-A1: GitHub README has original, accessible SVG branding for light/dark, working badges and a clear demo link; no official endorsement claim.
- D1-A2: Setup, ports, optional Groq credentials, test commands and demo data boundaries match executable behavior. Docker documentation distinguishes prepared pipeline from an actually published image. Every claimed runnable command is exercised against its applicable environment.
- D1-A3: SVG assets render without external code/fonts or references; README links and visual layout are reviewed on GitHub/browser.

### D2 — automatic demo delivery

Status: accepted historically in [#16](https://github.com/metaneutrons/HASI/issues/16);
the Vercel project has since been retired. Current deployment work is #79.

- D2-A1: Vercel production branch is `main`, connected to this repository. Every main merge is eligible for deployment, including documentation-only merges; skip-unaffected/ignore policy cannot suppress it. PR preview protection remains enabled.
- D2-A2: A main merge produces a READY deployment at the exact merge commit, region `fra1`, and the public alias points to it. A real chat/source lookup and a protected document path are verified. No second deployment mechanism duplicates the Git integration.

### D3 — qualified multi-platform container releases

- D3-A1: A digest-pinned, non-root container builds on native Linux amd64 and arm64, starts without a development toolchain and passes the shared backend smoke flow using isolated PostgreSQL. No credentials, private research or workstation state enters build context, layers or image metadata. The current image truthfully provides the explicit prototype/demo runtime only.
- D3-A2: Release Please is the sole production version/tag authority. It uses the existing dedicated GitHub App, with secrets in a protected environment. A merged release PR creates a draft release and dispatches the release pipeline at that exact tag; no independent push/tag/release trigger duplicates it.
- D3-A3: Canonical tag, manifest/package version, source revision and immutable tag policy are verified before publication. PR and manual qualification cannot publish stable images or move `latest`. Valid and invalid identity/configuration cases demonstrate the gate.
- D3-A4: Both platform payloads are qualified before a combined GHCR index is promoted. Published images carry exact version tags, verified provenance, SBOM and keyless signing. The index is verified to contain linux/amd64 and linux/arm64; signatures and attestations bind the repository/workflow/ref. `latest`, major and minor aliases move only after successful final qualification and release promotion.
- D3-A5: A read-only `qualification_only` dispatch on `main` exercises the same native build, smoke, SBOM, signing and provenance jobs and uploads CI artifacts only. It creates no tag, GitHub Release or GHCR image. This replaces the initially planned manual prerelease test because actual releases must come exclusively from Release Please. The first requested Release Please release must separately prove the real tag/draft dispatch, public registry readback and promotion path; a successful qualification dispatch alone does not establish a published or fully qualified release.
- D3-A6: Partial/unavailable configuration fails before a public mutation; unknown publication outcomes do not authorize blind retries. Failure leaves the draft/candidate identifiable and prevents stable promotion. Runtime upgrade/rollback uses pinned image digests and compatible state migrations.

D1 precedes the first production release. D2 was verified independently and is closed. D3 native/container work may proceed independently; final branch refresh and expensive qualification follow serial merge order without weakening required checks. The existing `CI Success` remains mandatory. #79 is the current demo-deployment path, not a reopening of D2. No npm, Homebrew, APT or other package channel is in scope.

## Open operational decisions and limits

Provider and database credentials remain server-side and are never image build arguments. The requested DeepInfra/DeepSeek-V4.1-Flash addition is not yet verified; issue [#81](https://github.com/metaneutrons/HASI/issues/81) tracks DI-A1–DI-A4 before the final M6 comparison. See the unified order in [consolidated delivery](consolidated-delivery.md). Institutional deployment and protected-data use require M8 identity/source authorization and provider approval separately from shipping a container. The first stable version is determined through the Release Please PR; no manual production tag is permitted. The demo source-deployment work in #79 does not publish a GHCR image or create a release.

Read [repository standard](../architecture/repository-standard.md), [public demo](../architecture/public-demo.md) and [knowledge MCP](../architecture/knowledge-mcp.md) for existing boundaries. External publication identity and exact verification results will be recorded in the milestone issues rather than duplicated as acceptance checklists here.
