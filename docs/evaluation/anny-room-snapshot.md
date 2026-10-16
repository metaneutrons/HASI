# Anny HsH resource catalog snapshot

Snapshot date: 2026-10-16. This fixture contains 61 sanitized resource records,
including 30 roots and 31 actual parent-child links, plus all 9 service catalog
records. The read-only Admin query used
`/api/v1/resources?filter[exclude_child_resources]=false&include=parent`.
Including children returned the full catalog. The `include=parent` relationship
was observed working in Anny Admin even though it is absent from the published
API specification; treat that behavior as an observation to recheck, not as a
documented API guarantee. No booking or availability operation was used to
produce this fixture.

## Resource kinds and units

`kind` follows source category ID and the actual child links. Category `60`
(`Flex Desk`) with children is an `office` container; a category 60 leaf is a
`workplace`. Category `6` is a `meeting_room`. Other categories map to `room`.
The schema allows `lecture_hall`, but this snapshot contains none. The 18 office
containers, 37 workplace leaves and 6 meeting rooms retain their source IDs,
names, category IDs and names, parent IDs, source `quantity`, and `hasChildren`
state. Parent IDs come from the resource tree; no name-based relationships are
inferred. The snapshot has no duplicate IDs, missing parents, cycles or
disagreement between `hasChildren` and actual child links.

`quantity` is the source catalog quantity, not a seat count. The 37 workplaces
and 6 meeting rooms each have quantity 1; office containers have quantities 1,
2 or 3. `capacity` is populated only from a positive integer `Kapazität`
property declared as type `number`. Six meeting rooms have a known capacity;
capacity is null for all offices and workplaces. Names and quantities are not
used to estimate people capacity. The composed demo resource list omits
`quantity` and asserts quantity 1 for each included leaf.

## Curated fields

- All descriptions are blank. The 30 root entries retain their already-curated
  safe location and feature fields. The 31 children use their own resource
  properties; features are not inherited from a parent. A missing child
  `Gebäude` property may use its parent's curated location, but every child in
  this snapshot has its own safe building string, so no location inheritance
  was needed. In total, 54 resources have a location and 7 have none.
- `features` contains only allowlisted property labels whose own value signals
  presence. Raw property values are excluded. Counts across all 61 resources:

  | Feature | Resources |
  | --- | ---: |
  | Beamer | 2 |
  | Docking Station | 0 |
  | Flip-Chart | 2 |
  | Hybride Besprechungstechnik | 1 |
  | Höhenverstellbarer Schreibtisch | 55 |
  | Kinderspielzeug | 2 |
  | Metaplanwand | 1 |
  | Monitor | 53 |
  | Whiteboard (Wand) | 1 |
  | XL-Monitor | 1 |

- `serviceIds` preserves each actual direct resource-service relation in source
  order. All 9 service records are retained; 8 are linked by at least one
  resource and 1 currently has no direct resource link. `serviceId` is set only
  when a resource has exactly one linked service: 9 resources have one and 52
  have multiple. The demo catalog explicitly prefers service `76878` for a
  workplace when linked; otherwise it chooses that resource's first linked
  service. Meeting rooms and other leaf kinds use their first linked service.
  This is a deterministic simulation choice, not a live eligibility or
  booking-rights determination.
- `hshDemoCatalog.resources` contains only 43 leaf resources: 37 workplaces
  and 6 meeting rooms. Office containers are excluded. The presentation map
  carries each leaf's kind and actual parent ID/name alongside its existing
  capacity, location, features and selected demo service.

## Exclusions and limits

The fixture excludes service configuration, booking rules and flags, maximum
booking quantities, credentials, personal/contact data, custom-form payloads,
addresses, coordinates, and non-allowlisted properties. It contains no live
availability or booking state; the top-level markers are `synthetic`. Current
availability, booking rights and booking eligibility are not represented.
Mock personas and the selected demo service do not establish authority to make
a live booking. The fixture documents a read-only catalog snapshot and does not
verify a production Anny integration.
