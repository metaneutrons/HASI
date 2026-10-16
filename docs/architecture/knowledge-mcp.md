# Knowledge MCP and source delivery

Status: first synthetic demo implementation, 2026-10-16. No institutional source connector or production SSO authorization is configured.

`de.hsh.hasi.knowledge` is an independently versioned MCP plug-in. It uses the same manifest pinning, signed actor context, replay protection, schema validation and registry administration as the anny plug-in. Its read-only tools are `knowledge.search` and `knowledge.get_document`. The demo runs them under `/plugins/knowledge/mcp`; a separate deployment can expose `/mcp` on its own configured origin. The standalone local service runs on port 4103.

The corpus contains 60 entirely fictional Service-IT/Intranet documents. The evaluation cases in the fixture are excluded from retrieval. No protected Safari capture, original body or private source mapping is delivered by this plug-in. The initial search uses a deterministic lexical index; changing the conversational model does not rebuild this index. This is a baseline, not a semantic-search quality claim.

The host derives one `knowledge:audience:<role>` permission from the authenticated demo persona. The plug-in filters the document set before scoring, returning titles, bodies or citations. Direct document retrieval repeats the same check. These labels test access-control behavior; they are not real HsH groups or permissions. All fixture bytes are public source code and are unsuitable for confidential material.

Chat calls `knowledge_search`, which bridges to the registered MCP search tool. It passes at most three bounded documents as untrusted tool data to the selected Groq profile. The host creates source cards from validated document IDs. The model cannot supply a source URL or invent a trusted source card. A generated citation is not proof that a document supports the claim; evaluation must check that separately. Plain text rendering executes no source HTML or embedded content.

`/sources/:id` is the demo document reader. It retrieves the body through authenticated `/api/knowledge/documents/:id`, which calls MCP `knowledge.get_document`. Unknown and unauthorized documents produce the same generic response. API responses are private and not cached. An account change remounts the reader and repeats authorization; the page shell contains no document body. Previously seen content cannot be recalled from a person or their browser. The current local chat-history implementation is approved only for public demo fixtures; production requires a defined revocation and retained-context policy.

## Institutional adapters

Keep the same search/document tools and replace the synthetic repository with authorized Service-IT and Intranet adapters. Production identity must derive permissions from verified HsH SSO and source authorization. Filter before retrieval/ranking and minimize outgoing context; a model provider separately needs approval for the full data classification. A demo role must never establish production access.

A production source record needs an opaque ID, source-system ID, revision, access policy and canonical original URL. Keep that mapping server-side. The host resolves a cited ID to its approved HTTPS origin and safe path after authorization. The final source link can open the original Service-IT/Intranet page, where HsH SSO and the source system enforce access again. Do not forward SAML assertions or source cookies to models, browsers at unrelated origins or plug-in payloads. Source links alone do not replace retrieval ACL checks.

A protected source proxy is optional for formats that cannot be linked directly; it must repeat authorization and sanitize delivery. The demo reader is required because its documents are fictional and have no HsH original. It must not redirect fictional procedures to real institutional pages. Real source adapters, canonical link resolution, rights synchronization/revocation, institutional provider approval and production context retention remain implementation work.

## Demo contract migration

The anny 0.2.0 contract accepts opaque vendor IDs and unknown seat counts. The deployed composition explicitly approves the previous 0.1.0 manifest digest for this one migration. The registry verifies the complete signed previous state, binds it to the same workspace and plug-in, validates the new live pin and retains the enabled/disabled flag using compare-and-set. It discards pending update candidates. Unlisted or altered old state fails closed. Existing sessions are retained. The imported catalog gets a distinct synthetic calendar key; old mock records expire under the existing retention policy and are not imported into this calendar. Old room proposals fail the version check and must be recreated. This does not turn an incompatible third-party update into an automatically approved update.

Rollback across this contract change is not an alias-only operation: the old deployment cannot read a registry slot pinned to 0.2.0. Migration retains a verified signed previous slot at `<registry-key>:backup:<previous-manifest-digest>`. An operator must restore that signed slot under its original key (same scope and signing secret) before using an old deployment, or use a forward fix. The old catalog calendar is retained separately. A production rollback of institutional data needs its own tested migration procedure; none is claimed here.
