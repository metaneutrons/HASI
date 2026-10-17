# Production identity and anny authorization

Date: 2026-10-17. Status: proposed production integration boundary; not a working
institutional login or live booking authorization implementation. The public
demo's personas/customer IDs/resource grants are synthetic fixtures.

## Separate three decisions

1. **Authenticate to HASI:** register HASI with the HsH IdP using its supported
   institutional protocol. Existing Anny SAML SSO does not force HASI's internal
   API to use SAML; a trusted broker can also expose OIDC to HASI. Determine the
   actual IdP configuration and service-specific attribute release first.
2. **Bind the anny account:** use a server-owned mapping from a verified stable
   institutional identifier (including issuer/namespace) to the correct Anny
   customer/account. Do not accept an identity, customer ID, role or community
   chosen by the model/browser. An email address can help reconcile an account
   but must not silently establish a permanent binding: it may change, be an
   alias or be reassigned. SAML transient IDs and pairwise identifiers scoped to
   different applications cannot simply be equated across HASI and Anny.
3. **Authorize each operation:** resolve the user's current resource/service
   eligibility and community memberships. Filter discovery, validate availability
   and recheck immediately before confirmed execution. The integration must
   enforce booking rules at the actual write boundary; a preflight UI check
   alone cannot guarantee that rights are still valid.

## Preferred path to verify with Anny

Anny documents OAuth2 Authorization Code for delegated access and PKCE, with a
custom client available through support. Seek a supported server-side flow
which grants HASI a customer-scoped token for the HsH user. The user's existing
HsH SSO can assist Anny login, but HASI must not copy browser cookies or assume
an exchange of its SAML assertion/session for an Anny bearer token exists.
Keep access/refresh tokens encrypted server-side, bound to the verified subject
and tenant, with minimum scopes and revocation handling; never send them to a
model or expose them as plugin tool arguments.

The Customer API's instant booking uses the authenticated customer context.
Confirm with Anny which supported OAuth grant/token type supplies that context
and whether the route enforces the tenant's community, resource, service and
booking rules. This is a qualification requirement, not established behavior.

An Admin API token and `orders/from-config` can create bookings on another
customer's behalf and bypass public checkout. Setting `customer_id` does not
itself prove that customer's eligibility was checked. Do not enable real writes
on that assumption. If that route is necessary, obtain Anny's authoritative
contract and enforce an independently trusted HASI authorization policy as well.
Unknown or unavailable rights checks deny the write.

## Attributes and communities

Anny supports mapping IdP attributes/groups to communities and profile fields,
including Email and Identifier. This does not prove which attributes HsH releases
today or what HASI will receive as a separately registered service. Inspect Anny's
SSO & Security → Attribute Mapping → My attributes with the institution's operator
and agree HASI's own required claims with the HsH identity team.

Use trusted institutional groups to assign narrowly scoped Anny communities and
resource/service policies. Verify removal and deactivation behavior as well as
initial assignment. Anny's documented SCIM provisioning can manage lifecycle;
its guide says SCIM becomes the attribute source and supersedes ordinary SSO
attribute mapping when active. Avoid conflicting sources of membership truth.

## Open qualification questions

- Which stable identifier, email and group attributes does HsH release to each
  application? What are their issuer, scope, mutability and account lifecycle?
- Which Anny API field corresponds to its SSO Identifier? Is its mapping stable,
  and what supported lookup/write flow resolves an existing customer? A published
  `idp_user_id` response field does not establish those semantics.
- How does HASI obtain a customer token, and which rules does Customer instant
  booking enforce? Does Admin `orders/from-config` enforce the selected customer's
  eligibility if it must be used instead?
- What is the authoritative per-resource/service eligibility result? The current
  `community-restrictions` response schema is only a generic object; do not invent
  its fields or implement an allow decision from that undocumented shape.
- How quickly are group removal, account deactivation and revoked grants enforced,
  including cached discovery, pending proposals and refresh tokens?

Qualify allowed/denied groups, service-specific restrictions, a forged customer
ID, ambiguous account linking, removed memberships after discovery, deactivation
before confirmation and unavailable authorization services against an authorized
test tenant before live booking/cancellation is enabled.

Sources: [Anny API authentication](https://docs.anny.co/developers/guides/authentication),
[SSO overview](https://docs.anny.co/en/sso-overview.md),
[attribute mapping](https://docs.anny.co/en/attribute-mapping.md),
[SCIM provisioning](https://docs.anny.co/en/scim-user-provisioning.md),
[Customer communities](https://docs.anny.co/developers/guides/customer/communities),
[instant booking](https://docs.anny.co/developers/api-reference/customer/endpoints/bookings/create-an-instant-booking),
[Admin booking creation](https://docs.anny.co/developers/guides/admin/booking-creation.md)
and [community restrictions](https://docs.anny.co/developers/api-reference/customer/endpoints/resources/get-community-access-restrictions-for-a-resource).
