# Conversational demo knowledge search relevance

Date: 2026-10-20. Related to M6 #53 and the source-navigation UX review.

The deployed explicit Dialog-Demo query `Mein VPN funktioniert nicht.` returned
a VPN troubleshooting FAQ alongside unrelated printing/canteen and private-mail
forwarding documents. A signed MCP regression on the unchanged local scorer
reproduced that result and failed specifically on the unrelated document IDs.
Generic pronouns and failure/negation words were contributing strong title
scores even without a relevant topic.

The demo lexical adapter now normalizes German/English stop terms consistently
with document/query tokens and deduplicates query terms. Discriminative topic
matches determine eligibility and primary ordering. Failure/negation terms remain
secondary ordering context, so they can prefer a troubleshooting page among
equally topical documents but cannot create a result themselves. Token-bounded
phrase scoring uses the same normalized topic sequence. A stable corpus-order
tie-break remains. No topic-specific resource or expected ID is embedded in the
runtime scorer. Access filtering still precedes scoring/acquisition; source
permissions, institutional retrieval and document bodies are unchanged.

The first stop-only iteration removed unrelated hits but ranked the matching VPN
troubleshooting FAQ fifth. Root review rejected that loss of intent; the final
regression requires it first and checks that all returned records have the VPN
topic. Signed MCP tests also exercise MFA, English wording, filler/failure-only
queries returning no results, and existing audience denial. Seven focused tests,
affected typed lint, root types and diff checks pass on Node 24. Root independently
reviewed source/test boundaries, without claiming another browser or model run.

This is a bounded lexical development correction. It does not establish a
curated retrieval benchmark, universal semantic relevance, grounding quality,
source-rights approval or M6/M7 acceptance. The VPN fixtures' invented operating
profiles and the supplied booking/topic-switch failures remain open in #53.
Existing numbered source links, same-tab document reader, exact-message return
and draft preservation were independently checked on deployed e15f881 and are
separate from this ranking change. Hosted checks/delivery for this candidate
must be recorded in its implementation PR before a deployed-fix claim.

| Qualified file | SHA-256 |
| --- | --- |
| `apps/knowledge-plugin/src/index.ts` | `cd9dcc929efa162e1ee5c7720751b6bdf507f2e958667009e0aaedc13ce06eab` |
| `tests/knowledge-plugin.test.ts` | `b417c2d868e5d332ca4bafbeaf14f14bddd3f91bc7afd05b2788b029a349d989` |
