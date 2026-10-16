# Synthetic knowledge seed for the HASI demo

This document describes a reviewed public demo corpus of 60 fictional knowledge
documents. It is intended to exercise retrieval and response behavior, not to
represent a university's actual services or rules. Every document begins with
an explicit synthetic-data notice and has `publicationStatus: "demo"`.

## Provenance and limits

The source taxonomy is limited to topic labels supplied for ServiceIT and
Intranet navigation: examples include WLAN, VPN, multifactor authentication,
email, CampusCard, cloud, printing, accounts, security, services, timekeeping,
qualifications, organization, committees, forms, notifications, library and
research records, guest invitations, campus navigation, mobility, family
service, language guidance, and learning media. These labels informed topic
selection only. No procedure, person, contact detail, private URL, account,
date, organization chart, or system name was copied from or matched against a
real source. This is not an anonymization claim. All procedures, examples,
dates, and named systems are invented; no text asserts a real institutional
policy or workflow.

The dataset is `fixtures/knowledge-demo-v1.json` (`schemaVersion: 1`,
`datasetId: "hasi-knowledge-demo-v1"`, `createdAt: "2026-10-16"`). Each
document has a stable synthetic citation ID, a visible `Demo:` title, revision
1, a source category, a language, tags, and a per-document disclosure at the
start of its text. It has no original-source URL. The corpus has been reviewed for publication as fictional demo content; the evaluation labels remain draft and require task-quality review before they become benchmark ground truth.

## Demo audiences are fixtures, not access control

`demoAudience` values model test cases only. All 30 ServiceIT documents are
marked for student, employee, and admin personas. Of the 30 Intranet documents,
14 are marked for all three personas, 12 for employee and admin, and 4 for
admin only. These fictional labels do not establish, predict, or imply any
real user's rights. The JSON file itself is public data: every document,
including those with restricted demo audiences, remains readable from the
fixture. Filtering in a UI or prompt would not enforce access control.

The evaluation set contains 80 queries. It includes at least 12 role-denial
cases and 12 questions outside the corpus, which should produce a generic
denial or an abstention respectively. Denied cases have empty
`expectedDocumentIds`; the model context must not receive the denied
documents' titles, text, tags, IDs, or citations. Four queries require multiple
documents as evidence. Four explicit conflict groups pair incompatible
fictional guidance; their queries expect abstention because the corpus provides
no basis for choosing a winner. All documents use revision 1, so no implicit
recency rule can resolve those conflicts. English is represented by 12
documents and at least 16 evaluation queries.

## Search integration and production requirements

The demo knowledge MCP now searches this seed. Its backend uses trusted test-persona
permissions before ranking documents or exposing their metadata,
counts, scores, snippets, or citations to a user or model. Server-side access
to metadata may be needed to evaluate that authorization; the runtime must
enforce the resulting decision before search results enter a model context or
user-visible response. Retrieval and response generation must use the same
server-side policy, and a denied request must not reveal which restricted
document matched. Evaluation fixtures do not grant permissions.

The fixture contains no mapping to original private sources. Any such mapping
used during synthesis must stay local and outside this public dataset. A future
production system should return real source references to users authorized to
see them; synthetic citation IDs are not substitutes for those references.
