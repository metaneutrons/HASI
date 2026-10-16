# Demo and container delivery

Date: 2026-10-16. User-authorized delivery requirements: every merge to `main` updates the Vercel demo; versioned container releases are created only through Release Please, with Linux amd64 and arm64 support. This plan adds delivery infrastructure without declaring the institutional MVP complete.

Tracking: [epic #14](https://github.com/metaneutrons/HASI/issues/14), [D1 #15](https://github.com/metaneutrons/HASI/issues/15), [D2 #16](https://github.com/metaneutrons/HASI/issues/16), [D3 #17](https://github.com/metaneutrons/HASI/issues/17). Requirements live here; implementation stages and evidence belong in the linked milestone issues.

## Measured baseline

Main `319ac132181ae64f37960b7e9953652fbe31e904` contains the server-backed synthetic demo, knowledge MCP and curated room snapshot. Required CI passed on Node 24/26; local PostgreSQL qualification passed 135 tests. The GitHub/Vercel integration automatically deployed this exact merge to production (`dpl_BM2jEHHGDKruPiTtWHoxFvq5KkHV`, Frankfurt); there is no container Dockerfile or active release workflow. Release Please configuration exists but is inactive. All workspace packages are private. Real SSO and institutional connectors remain open.

## Milestones and acceptance authority

### D1 — README and branding

- D1-A1: GitHub README has original, accessible SVG branding for light/dark, working badges and a clear demo link; no official endorsement claim.
- D1-A2: Setup, ports, optional Groq credentials, test commands and demo data boundaries match executable behavior. Docker documentation distinguishes prepared pipeline from an actually published image. Every claimed runnable command is exercised against its applicable environment.
- D1-A3: SVG assets render without external code/fonts or references; README links and visual layout are reviewed on GitHub/browser.

### D2 — automatic demo delivery

- D2-A1: Vercel production branch is `main`, connected to this repository. Every main merge is eligible for deployment, including documentation-only merges; skip-unaffected/ignore policy cannot suppress it. PR preview protection remains enabled.
- D2-A2: A main merge produces a READY deployment at the exact merge commit, region `fra1`, and the public alias points to it. A real chat/source lookup and a protected document path are verified. No second deployment mechanism duplicates the Git integration.

### D3 — qualified multi-platform container releases

- D3-A1: A digest-pinned, non-root container builds on native Linux amd64 and arm64, starts without a development toolchain and passes the shared backend smoke flow using isolated PostgreSQL. No credentials, private research or workstation state enters build context, layers or image metadata. The current image truthfully provides the explicit prototype/demo runtime only.
- D3-A2: Release Please is the sole production version/tag authority. It uses the existing dedicated GitHub App, with secrets in a protected environment. A merged release PR creates a draft release and dispatches the release pipeline at that exact tag; no independent push/tag/release trigger duplicates it.
- D3-A3: Canonical tag, manifest/package version, source revision and immutable tag policy are verified before publication. PR and manual qualification cannot publish stable images or move `latest`. Valid and invalid identity/configuration cases demonstrate the gate.
- D3-A4: Both platform payloads are qualified before a combined GHCR index is promoted. Published images carry exact version tags, verified provenance, SBOM and keyless signing. The index is verified to contain linux/amd64 and linux/arm64; signatures and attestations bind the repository/workflow/ref. `latest`, major and minor aliases move only after successful final qualification and release promotion.
- D3-A5: A deliberately planned, never-promoted prerelease test proves the hardened GitHub pipeline before a stable publication. Test refs do not reach stable package aliases. A production release is never declared complete from a successful dispatch alone; the actual Release Please path and public registry results need evidence.
- D3-A6: Partial/unavailable configuration fails before a public mutation; unknown publication outcomes do not authorize blind retries. Failure leaves the draft/candidate identifiable and prevents stable promotion. Runtime upgrade/rollback uses pinned image digests and compatible state migrations.

D1 precedes the first production release. D2 can be verified independently. D3 native/container work may proceed before D1 merges; final branch refresh and expensive qualification follow serial merge order without weakening required checks. The existing `CI Success` remains mandatory. No npm, Homebrew, APT or other package channel is in scope.

## Open operational decisions and limits

The runtime still needs server-side Groq and database configuration supplied by its operator. Credentials are never image build arguments. Institutional deployment requires real identity/source authorization and provider approval separately from shipping a container. The first stable version is determined through the Release Please PR; no manual production tag is permitted.

Read [repository standard](../architecture/repository-standard.md), [public demo](../architecture/public-demo.md) and [knowledge MCP](../architecture/knowledge-mcp.md) for existing boundaries. External publication identity and exact verification results will be recorded in the milestone issues rather than duplicated as acceptance checklists here.
