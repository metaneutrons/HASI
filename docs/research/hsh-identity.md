# Hochschule Hannover SSO identity evidence

Research date: 2026-10-09. This review used public pages and published metadata only. I followed the service.it login redirect to the IdP page but did not submit credentials.

## Current `service.it` login

HsH IT documents that `service.it.hs-hannover.de` is accessed with an HsH account. Its account overview specifically identifies an SSO account in the form `abc-123-sso` and lists service.it, Moodle, AcademicCloud, VPN, and Campusmanagement among its uses. The same page distinguishes this from the Masteraccount used to manage accounts. These are HsH account types and local login names; the pages do not state that either is a stable SAML subject for another application.

The public `Log In` link at `service.it.hs-hannover.de` points to `/login`. A public GET to that path redirected to `https://idp.hs-hannover.de/simplesaml/module.php/saml/idp/singleSignOnService` with a SAML request for the service portal. The request names the SP as `https://service.it.hs-hannover.de/saml2/meta`; the flow reached the HsH IdP sign-in page and stopped there. This is direct evidence that the current service.it portal uses SAML with the HsH IdP. It proves the portal's configuration only; it does not establish that Hasi is provisioned or that HsH will expose this protocol to Hasi.

The service.it SP metadata at `https://service.it.hs-hannover.de/saml2/meta` identifies that same SP, declares SAML 2.0, and publishes an HTTP-POST assertion consumer endpoint. It contains no `RequestedAttribute` entries. That says nothing conclusive about attributes actually released to the portal, and still less about a new SP.

## HsH IdP metadata

The live DFN-AAI IdP metadata aggregate contains an entity for Hochschule Hannover:

- Entity ID: `https://idp.hs-hannover.de/idp/shibboleth`
- Protocol: SAML 2.0
- SSO endpoint: `https://idp.hs-hannover.de/simplesaml/module.php/saml/idp/singleSignOnService`, with HTTP-Redirect and HTTP-POST bindings
- Advertised NameID format in the SSO descriptor: transient only
- Scope: `hs-hannover.de`
- DFN entity category: `http://aai.dfn.de/category/highmeducation-member`

The transient NameID advertised for SSO is not a suitable durable account key. The separate Attribute Authority descriptor advertises persistent and transient formats; that does not establish a persistent identifier in an SSO assertion for hasi. The entity category and scope describe federation metadata; neither establishes a user's role or an attribute release to hasi. No OIDC discovery URL appeared in the observed service.it flow, so public evidence reviewed here establishes SAML for that portal, not OIDC support for HsH or hasi.

## Attributes and stable identity for Hasi

Public HsH IT documentation says students receive addresses ending in `@stud.hs-hannover.de`, and the account overview lists staff address forms ending in `@hs-hannover.de`. This documents address conventions, not release of the SAML `mail` attribute to a new service provider. The published IdP metadata likewise does not show that `mail`, `eduPersonAffiliation`, or `eduPersonScopedAffiliation` is released to Hasi. It contains no per-user attribute values.

DFN-AAI documentation is explicit that the IdP's configuration determines the attributes a service provider receives. An SP may request attributes in metadata or an authentication request, but the IdP may ignore those requests; releases can be configured by SP entity ID or entity category. Therefore, the actual Hasi attribute release remains unknown and must be confirmed by HsH IT for Hasi's SP entity ID. Do not make email or affiliation a login prerequisite until that release is confirmed.

For a durable Hasi account key, ask HsH IT to release a SAML `pairwise-id` for Hasi (or confirm another stable, non-reassignable subject). DFN recommends `pairwise-id` for a service-specific pseudonymous identifier and says not to use `mail` or `eduPersonPrincipalName` as identifiers. If released, key the external identity by the IdP entity ID plus the pairwise subject. Its pairwise nature means it is scoped to this SP; changing Hasi's SP entity ID may affect the value. The currently advertised transient NameID cannot substitute for it.

Before implementation, HsH IT should confirm: (1) whether Hasi can use SAML and what SP metadata/entity ID to register; (2) whether a stable pairwise subject is released to that SP and its persistence/reassignment behavior; and (3) whether `mail` and the required affiliation attribute are released, including which values identify students, staff, and other account classes. The public material examined does not answer these questions.

## Sources

- [HsH IT service portal](https://service.it.hs-hannover.de/en/) — public login entry point.
- [HsH account overview](https://service.it.hs-hannover.de/de/faqs/ubersicht-accounts/) — account types, SSO account use, and address forms.
- [HsH SSO account setup](https://service.it.hs-hannover.de/de/faqs/sso-account-einrichten/) — SSO account setup in the account manager.
- [DFN-AAI live IdP metadata aggregate](https://www.aai.dfn.de/metadata/dfn-aai-idp-metadata.xml) — HsH IdP entity and advertised SAML capabilities.
- [DFN-AAI metadata documentation](https://doku.tid.dfn.de/de:metadata) — published federation metadata and signature information.
- [DFN-AAI attribute transmission](https://doku.tid.dfn.de/de:aai:attributes_transmission) — IdP control over actual releases and SP requests.
- [DFN-AAI identifier best practices](https://doku.tid.dfn.de/en:aai:attributes_best_practice) — recommended subject identifiers and guidance against email as an identifier.
- [DFN-AAI subject identifier configuration](https://doku.tid.dfn.de/de:shibidp:config-attributes-subject_ids) — per-SP subject-id and pairwise-id release configuration.
