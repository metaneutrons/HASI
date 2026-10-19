# Offline evaluation oracle support

Date: 2026-10-19. Status: deterministic synthetic fixture checks implemented;
the dataset and model quality remain unreviewed.

The offline runner accepts an optional server-owned `oracle` dependency. The
specification is a strict, versioned JSON object with one or more assertions and
unique stable IDs. It is validated and copied before the injected transport is
called. It is separate from the evaluation case and model response, so expected
assertions, candidate documents and oracle contents do not enter the projected
model input.

Supported assertions are literal `text_contains` and `text_not_contains`, exact
`citations_required` and `citations_allowed` identities (`sourceId` plus
`revision`), and exact `tool_proposals_required` and `tool_proposals_allowed`
records (`tool` plus JSON `arguments`). There is no regex, executable expression,
or automatic interpretation of natural-language expected strings. Required
assertions need at least one expected item. An empty allowed list is an explicit
check that no citation or tool proposal appears. Proposal arguments compare
recursively with object keys normalized and array order preserved; proposal
collections compare as multisets, so duplicate calls require duplicate entries
in the allowance.

Every oracle assessment also checks that each returned citation identity exists
in the exact authorized model projection. Citation assertions must themselves
refer only to projected evidence. This prevents an oracle from legitimizing a
denied source or a different revision. Proposed tools are recorded and compared
as data; the evaluation runner never invokes them.

Completed oracle results are labeled
`deterministic_fixture_oracle` with scope `synthetic_offline_fixture_only` and
per-assertion IDs and pass/fail results. Each result
also binds the canonical oracle to a domain-separated SHA-256 digest; changing
assertions changes that identity, while reordering JSON object keys does not.
These checks establish only whether a
synthetic transport response matches explicit fixture assertions. They do not
establish model quality, a benchmark result, institutional approval, or live
provider behavior. Runs without an oracle retain the prior
`not_assessed` / `synthetic_transport_only` result. Transport failures and
invalid responses remain `not_run`.

No evaluation cases or review labels were changed for this addition. The
20-case corpus remains draft development material and has not been reviewed or
adjudicated. No provider, network, or paid model calls were made for this
implementation.
