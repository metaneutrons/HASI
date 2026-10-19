# M3 reviewed adapter-to-chat authorization evidence

Date: 2026-10-19. Integration baseline: `e24adaf832eb7e5025b00c34f4b2b330676e09a0`.
Scope: the synthetic M3 #50 adapter acquisition, source review, signed snapshot,
permission-aware search, retained context and citation chain. M2 dependencies
and final M8 institutional acceptance remain separate.

`tests/knowledge-adapter-flow.test.ts` exercises the real `WebContentAdapter`
and `MediaWikiContentAdapter`, `ContentSnapshotProducer`, signed source exports,
`InstitutionalKnowledgeRepository`, signed registry MCP calls and host API.
The source transport and embedding vectors are test doubles; content, source
rights, identities, keys and credentials are synthetic fixtures. The plugin
and API use their actual Fastify request handling through test injection; this
is not an independent network/process or institutional service test.

Root integration passed **33 tests across five knowledge suites** on Node
v26.11.1 and v24.21.0, including the integrated adapter scenario and image-review
regression below. The backend build, affected ESLint check and full root
TypeScript check passed. CI and the merge
revision belong to the delivery PR; these local results alone do not accept M3.

The scenario verifies these boundaries together:

- Both adapters reject acquisition into a snapshot before exact rendered-content
  review, with no embedding call and no producer state saved.
- The authenticated MediaWiki contract uses capability discovery, pinned oldid
  rendering and the revision fence. Every read asserts the exact request
  sequence; a changed final revision denies acquisition before embedding/state
  publication. No HTML request is made in this direct-adapter case; no fallback
  chain is configured here. Service-IT uses only its exact approved HTML page.
- Reviewed English Service-IT content and German Intranet guidance are signed,
  ingested and searched through the actual registry/plugin/API chain.
- A synthetic student sees the permitted Service-IT document and no private
  Intranet result. The same application persona role is used for the two test
  accounts: current source groups, not the persona label, establish source rights.
- A permitted staff subject receives reviewed instructional image guidance.
  The returned guidance contains the approved transcript and no image source URL.
  A different subject cannot resolve that retained context or follow its source
  citation. The permitted subject receives the exact approved original URL.
- A newly signed snapshot removes the staff source grant without changing the
  document revision or re-embedding its unchanged text. Search, old context and
  citation access all deny that former reader after ingestion.

Image guidance here means operator-reviewed synthetic transcripts bound to the
extracted image descriptors and rendered-content review. The adapters do not
fetch image bytes or perform OCR. This test does not demonstrate pixel identity
or freshness when an image changes at the same URL. It proves neither actual
HsH rights nor institutional review, live embedding quality or full M3 acceptance.
No real source, model, credential or business operation is used.

The approval-integrity regression in `tests/content-acquisition.test.ts` also
checks the source producer directly: the exact source plus reviewed image
records is accepted; changing a transcript under the old approval is rejected
before embedding or state publication; an explicit new approval permits the
updated guidance and increments the document revision; a changed extracted
descriptor invalidates that approval even if the source revision stays equal.
No-image approvals retain their digest. Inspection includes the configured
reviewed image records in its private artifact and digest so the operator can
review exactly what ingestion will check. It never approves them automatically.
