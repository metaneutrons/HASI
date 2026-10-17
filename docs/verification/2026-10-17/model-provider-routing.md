# Model provider routing and chat workspace verification

Date: 2026-10-17. Scope: [routing plan](../../plans/model-provider-routing.md),
R1/R2 and the requested conversation-list presentation. Deployment evidence is
maintained in [R1 #33](https://github.com/metaneutrons/HASI/issues/33) and
[R2 #34](https://github.com/metaneutrons/HASI/issues/34), including exact revisions.

## Local evidence

- Type checking, linting and backend/web production builds passed.
- Independent policy review found and verified fixes for early chat/default
  initialization, actual fallback provider display and exhausted sibling targets.
- Focused router/store/HTTP boundary suite: 85 tests passed, covering the final
  fixes. Full local suite including the final regressions: 241 passed, one PostgreSQL
  suite skipped without a configured local database. Exact-head CI must exercise
  PostgreSQL and Node 24/26 before merge.
- The configuration CLI accepted the checked-in example (five connections,
  seven profiles). A copy with an inline `apiKey` field exited 1, displaying only
  the structural error path. Neither probe resolved credentials or called a model.
- Groq, OpenAI Responses/Chat, Anthropic Messages and OpenAI-compatible transports
  use mocked HTTP for adapter qualification. These checks do not establish live
  OpenAI, Anthropic or Custom provider compatibility. Automatic fallbacks remain
  disabled in the bundled configuration; transient failure scenarios are tested
  deterministically, without exhausting live provider quotas.

## Responsive browser evidence

Chromium device-metrics emulation measured `innerWidth` equal to document
`scrollWidth` at 320, 390 and 1280 CSS pixels. Checks covered the authenticated
chat, mobile conversation drawer and desktop disclosure, selection, renaming,
new-chat default, light/dark rendering and visible server-issued message times.
The 320-pixel drawer remained within the viewport (x=12, width=296).
These browser checks do not establish native iPhone/Safari or Android qualification.

The browser's ordinary screenshot wrapper scaled the emulated surface incorrectly;
CDP page capture with an explicit viewport clip was used for visual inspection.
Temporary emulation is reset after verification. Production workflow and screenshot
evidence are recorded after the automatic main deployment in R2.

## Documentation-only scope

Moodle, Stud.IP, HISinOne, SAP workflows and the all-programme examination-regulation
corpus are roadmap requirements, not implemented connectors. PDF extraction/OCR,
original preservation, cohort/version applicability, quality quarantine and exact
page citations remain acceptance requirements for that future corpus.
