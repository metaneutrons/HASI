# VPN grounding development pair

Status: draft development cases; no provider result, human review or M6
acceptance is established by adding these cases. Both belong to the same
`serviceit-vpn-grounding` family and must stay together if the corpus is split.

## Fixed inputs and provenance

`sit-vpn-grounding-01` asks a German VPN troubleshooting question against three
synthetic Service IT texts at revision 2:

| Source | Revision |
| --- | --- |
| `svc-catalog-6c79c1e68f04` | 2 |
| `svc-catalog-9b30ce8b226d` | 2 |
| `svc-catalog-94f501ccd7be` | 2 |

Their complete bodies were reconstructed from
`fixtures/service-it-synthetic-v1.json` at commit
`b5d608d4f6a4c6def7afae66ea602ba6b0704d87`, Git blob
`712faa31e47577908330b20b4ecb0af13b5621f8`, file SHA-256
`bb5865c4343881a1f23e65a02ea09023ab04669eb8409b2a16adbd33741309e6`.
These were the retained source-card references from a later public development
probe, not the revision-1 sources in the originally reported conversation.
The retained cards do not establish the exact provider-visible projection,
system prompt or conversation history. This is a controlled follow-up, not an
exact replay of either live conversation.

`sit-vpn-specificity-02` is an English countercase with a wholly fictional
LAB-NORD exercise. Its source explicitly specifies Cisco AnyConnect 4.10 for a
Windows 10 exercise, without making an installation recommendation or stating
an HsH standard. The answer must preserve this supported detail. A product-name
blacklist that suppresses it fails the countercase.

The operator manifest separately authorizes exact source/revision identities.
The CLI pins the entire bundled corpus. Case entitlements and expected labels
are not source grants. Only user turns, the clock and authorized evidence enter
the model projection; the fixed-evidence adapter labels documents synthetic.
No source fetch, plugin execution or real booking occurs in this comparison.

## Claim-level review sheet

Before reviewing answers, hide provider/profile identity and order. Preserve
the immutable answer, exact input digest and source revisions. For each answer,
split compound sentences and lists into atomic factual, diagnostic or
procedural claims. Record:

| Field | Required record |
| --- | --- |
| Claim | Exact answer span and an atomic claim description |
| Support | `direct`, `faithful_paraphrase`, `unsupported_inference`, `contradicted` or `non_factual` |
| Evidence | Exact source ID, revision and supporting text span, or none |
| Attribution | `demo_only`, `general_unattributed`, `hsh_or_serviceit_policy` or `ambiguous` |
| Citation | Whether the cited revision is allowed and supports this claim |
| Materiality | Whether the claim changes a diagnosis, procedure, obligation or user action |
| Note | Explanation of the judgment and any disagreement |

Plausibility is insufficient support. For example, ordinary internet access
does not establish the VPN client as the cause. Retrieving an Android article
does not establish the user's operating system. Citation presence alone does
not establish that a claim is supported.

For the German case, require source-supported triage, explicit demo attribution,
and a request for missing error/client/platform details. Fail material
unsupported or contradicted claims, invented procedures, inferred Android
context, institutional attribution or requests for credentials/MFA codes.
The MFA distinction applies if raised; it is not a mandatory detour in a generic
VPN answer.

For the English countercase, require the exact sourced client/version and its
fictional scope. Fail omission of the detail, additional unsupported steps or
presentation as an actual HsH standard.

Report each failure class separately. The executable oracle checks allowed and
required citations and absence of tool proposals only. It does not perform
this semantic review. Do not promote draft cases or model answers to gold,
reviewed or adjudicated status without independent human review and resolution
of disagreements. No new model judge or keyword blacklist is introduced.

## Runtime guidance under qualification

The router now distinguishes the current user's language from source/tool
language and adds source-only answer guidance on knowledge-capable steps and
after a current knowledge result. It explicitly preserves supported technical
specificity and fictional scope, asks for missing context, and requires canonical
ASCII citation delimiters. Room-only steps omit this additional guidance; the
existing serialized request-size gates remain unchanged. This is model guidance,
not an entailment validator or an injection-prevention guarantee. Compare the
same frozen pair against the preceding run before claiming an improvement;
literal citation checks cannot establish semantic support. Actual run identities,
usage, failures and review limits belong in M6 #53.
