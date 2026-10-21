# Ordinary article prose for the synthetic knowledge corpus

The operator requested disclosure only in the HASI website header, without
repeated notices in source articles, followed by a fresh manual review. This
candidate applies that editorial decision; it does not establish semantic
model quality or close M6.

## Corpus and boundaries

All 301 article titles and bodies have been revised: 271 Service-IT and 30
Intranet records. None contains `demo`, `synthetisch`, `synthetic`, `fiktiv`
or `erfunden`, case-insensitively. The 60-document seed retains its 48 German
and 12 English records and its four intentional contradictory pairs.

Compared with main `8941f89742ff1a88b67a9919952ee3e7161051b2`, every document
revision increases exactly once and its citation is updated. IDs, source
systems, language labels, audience/access metadata, tags and publication/data
classifications are unchanged. The combined unchanged identity projection has
SHA-256 `d045b08c06f803c7a176974d3e35283896a12cef95a536dd2715e4cd17fe9787`.
The seed date becomes 2026-10-21 for this new publication snapshot.

The complete Service-IT generator was run against the existing private metadata
inputs: 183 authenticated FAQs, one public FAQ supplement, 22 services, 11 news
items, 19 links and five forms. All 241 generated document objects matched the
candidate. No institutional article body or credential was imported. Reserved
`.invalid` addresses remain non-production examples. News titles no longer
combine partial historical dates with the separately generated schedule.
Azure account setup and Adobe password-reset questions have specific guidance
instead of unrelated phishing or software-catalogue prose.

## Runtime presentation

The central HASI notice remains. Source cards, the document reader, the restricted
Service-IT portal and exported Wiki article prose no longer repeat disclosures.
Wiki pages, navigation and site identity use `HASI Wissen` / `Wissen:`; the rollout
redirects the legacy page titles. HTML escaping, inert Wiki text and
source-origin/revision checks remain in place.
Deploying the application alone does not update a separately running source
replica: the Service-IT image and Wiki import require separate verified rollout.

The model instructions and knowledge tool description treat `synthetic` as
processing metadata, not a reason to refuse an evidence-supported answer or
repeat a disclosure. Missing/contradictory evidence must still be identified;
unsupported facts, current service status and broader institutional policy must
not be invented. Server-side authority, provider eligibility, budget and action
confirmation controls are unchanged.

## Validation and new review

Corpus hashes:

- `knowledge-demo-v1.json`: `288af45761e75db242772a0ac456fdcd0baccca45bce496e6db2bd625387e61a`.
- `service-it-synthetic-v1.json`: `96d333e421f2dd6d53036ac79224370f5fd7a498712d43c7d2f557b728f4f9d1`.
- Expanded fixed-case bundle: `82ff06922cccad9a2a741ce0894cdb548ab40a540e485c689308933488b59ef0`.

The required complete integration results are recorded on the implementation PR.
Corpus checks cover unchanged identity/access metadata, coherent citations,
absence of repeated disclosures and the corrected topic-routing cases. The
existing HTML-adapter, Wiki-breakout, source-rights and router-boundary tests
remain required. Text-only presentation changes do not qualify the pending
full mobile, accessibility or recovery matrix.

The original 22 development case objects and earlier answers are preserved.
Two [new editorial VPN cases](../../evaluation/editorial-vpn-review.md) have
separate IDs and exact source/revision authorization. Both source prose and
model instructions change, so a subsequent run cannot isolate their effects.
Prepare new unchanged answers and a blinded packet for Fabian; do not reuse the
earlier packet as review of these inputs. No new provider result, human rating
or semantic improvement is claimed in this report.
