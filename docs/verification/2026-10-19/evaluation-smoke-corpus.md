# M6 development smoke corpus extension

Date: 2026-10-19. Status: synthetic development fixtures only; no benchmark result.

The evaluation examples now contain 20 schema-valid cases. The original 12 case
objects were preserved; eight distinct draft cases were appended. All 20 remain
`synthetic: true`, `reviewStatus: draft`, and `datasetSplit: development`. The
corpus has 14 German and 6 English cases, 5 multi-turn cases, and 17 distinct
scenario families.

The additions cover multi-turn MFA recovery and a resolved-vs-earlier WLAN
incident; current-vs-retired intranet revisions; the Berlin spring DST gap;
cancellation with an unknown timeout outcome; a hidden cross-tenant candidate
document; and user-message and OCR-text injection attempts. Their facts, roles,
source revisions, clocks, canaries and action states are fictional. Expected
answers and runner fixtures remain case data for the server-side harness, not
model-visible evidence.

Focused verification:

- `pnpm exec vitest run apps/web/tests/evaluation-smoke-corpus.test.ts` — 4
  tests passed. It parses the complete corpus and checks aggregate case,
  language, turn, family, category, revision, ACL, time-gap, cancellation and
  attack coverage. It also checks that cancellation events, expected labels and
  the new runner-only canary are absent from projected model inputs.
- Focused TypeScript check of the evaluation schema and smoke-corpus test —
  passed.
- Focused ESLint on the smoke-corpus test — passed.
- `git diff --check` — passed.

This remains only a development smoke corpus. It does not establish human
review, source-owner approval, real integration behavior, provider quality,
blind-set performance or production safety. The OCR attack is explicitly
labeled and does not measure resistance to unmarked attacks. The proposed
200-case curated corpus remains future work.
