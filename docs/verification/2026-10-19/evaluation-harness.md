# Offline evaluation harness slice

Date: 2026-10-19. Status: offline harness-contract evidence only; M6 remains open.

This slice makes the existing 12 synthetic examples parseable and exercises an
explicit model-input boundary without contacting a provider. The cases remain
`draft` and in the `development` split. Their prompts, evidence text, expected
labels and provenance notes were retained. Schema version 2 adds a fixed clock
to the two cases that lacked one and an explicit revision to each evidence and
candidate-document identity.

`apps/web/src/lib/server/evaluation/case-schema.ts` validates strict bounded
case and dataset shapes. Descriptor-based JSON preflight enforces shared limits
before recursive Zod parsing: 2 MiB and 20,000 nodes per case, 16 MiB and
4,000,001 nodes per dataset, and 256 KiB and 20,000 nodes per JSON record.
Accessors, proxies, cycles, sparse arrays, non-JSON values and non-plain objects
are rejected without invoking getters. Nested fixture JSON, turns, evidence,
outputs and proposed calls have explicit bounds. Evidence requires a fixture
URI and positive revision.

`input-projection.ts` exposes only the fixed clock, user turns and evidence
whose exact source ID and revision are present in the server-supplied allowlist.
It does not use case entitlements or expected source labels as authorization.
The projection omits case identity, subject and entitlements, source URI and
access requirement, expected answers, candidate documents, tool fixtures,
application events, trusted application state and provenance.

`runner.ts` requires a transport function from its caller and has no default
transport, `fetch` path, provider adapter or tool executor. It applies one
256 KiB and 20,000-node preflight to the complete injected reply before
recursive parsing, including all proposed-call arguments. It records proposed
calls without executing them and accepts only measurements explicitly marked
`synthetic`. The SHA-256 digest covers only the projected model input. A
successful fake reply is `not_assessed`; a thrown or invalid transport result
is reported separately and never becomes an answer quality failure or pass.

Focused verification:

- `pnpm exec vitest run apps/web/tests/evaluation-runner.test.ts` — 13 tests
  passed, including positive fixed evidence, unauthorized and version-mismatched
  evidence, poisoned source text, gold/provenance exclusion, repeat digests,
  aggregate whole-case and whole-response limits, accessor/cycle/non-JSON
  rejection, synthetic measurements, and transport failures. A fetch spy
  observed no call.
- Focused ESLint on the three harness modules and test — passed.
- Focused TypeScript check of the three modules and test — passed.
- `pnpm --filter @hasi/web typecheck` — passed after preparing the generated
  workspace package with `pnpm --filter @hasi/plugin-sdk build`; the focused
  TypeScript check of the three modules and test also passed.

The fake transport is plumbing evidence, not model output or an M6 result. The
dataset still has 12 draft development cases, below the 20-case smoke set and
200-case target. This slice does not establish reviewed gold labels, validation
or blind splits, comparative quality, citation support, provider latency or
cost, repeated-run variation, or per-profile security acceptance. It does not
exercise real adapters or execute any proposed tool. Complete M6 still requires
the planned curated corpus and split controls, independent review, provider
comparisons and measured results, plus the required adversarial, access,
rendering/network, model-switch and workflow gates before M7. BUD-A1 remains a
prerequisite for paid runs; DeepInfra follow-up DI-A1–DI-A4 remains due before
the final provider comparison. No protected context or production write was
used here.
