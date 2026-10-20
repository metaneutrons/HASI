# Shared dialog identity

Date: 2026-10-20. Baseline: `cf83e82b04d01788bfb153da87250eab1dffe404`.
Fabian selected concept B: a lowercase h inside a dialog outline.

## Implementation

`apps/web/src/lib/hasi-brand.ts` owns the paths and asset palette. The pure
`HasiIcon` component renders the same paths in the login, navigation, chat
message headers, admin shell, Apple icon and Open Graph image. Decorative
instances are hidden from assistive technology; a standalone labelled instance
has an image role. The existing wordmark and separate institution attribution
remain. The synthetic Service-IT portal is a separate service with its existing
letter badge; this change covers the assistant application and README.

`pnpm brand:generate` writes the two README SVGs and favicon from that source.
`pnpm brand:check` detects drift before the web build. The Apple icon has an
opaque square background; the operating system supplies the home-screen mask.

## Verification

- The generator check succeeds on valid tracked assets (exit 0). An isolated
  copy with one extra newline in the favicon fails with exit 1 and identifies
  that asset. The repository files remain unchanged by the counter-probe.
- Web lint, TypeScript and the production-mode Next.js build pass. Both icon
  image routes were requested from the actual local runtime: Apple PNG
  180 by 180 and Open Graph PNG 1200 by 630, inspected visually.
- The local Node 26 TestIdP runtime, disposable PostgreSQL and explicit
  Dialog-Demo were used for browser checks. Login, desktop chat, message header
  and mobile admin display the selected mark. Light and dark schemes were
  inspected. At a simulated 390 by 844 viewport, both chat and admin report
  `innerWidth = documentElement.scrollWidth = 390`; the mobile mark is 28 by 28.
  The desktop navigation mark is 34 by 34 and message mark 18 by 18.
- Temporary viewport overrides were cleared and the owned local runtime was
  stopped after inspection. No provider credentials or paid model calls were
  used. Browser emulation does not establish native iPhone or M8 acceptance.

The delivery pull request records the exact head, mandatory integration gate,
CI and deployment outcome. This visual change does not qualify an entire
application or milestone. An existing protected Dialog-Demo greeting was
redacted on autosave during inspection; that separate chat-history finding
belongs to M2 and is not repaired by this identity change.
