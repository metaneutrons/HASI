# Anny HsH room catalog snapshot

This fixture contains all 30 room resources with complete detail records in the read-only HsH Anny catalog snapshot from 2026-10-16. The same snapshot includes the full catalog of 9 services. All resource detail IDs match the 30 resource IDs in the listing.

The fixture preserves room catalog metadata from Anny. Its `availability` and `bookings` markers are `synthetic`: the snapshot contains no live availability or booking state. Demo availability and booking writes are simulations. Demo grants do not establish real booking authorization.

## Field provenance and curation

- `resources[].id` and `name` come from each detailed resource’s `data.id` and `data.attributes.name`. All `description` values are empty. Four source descriptions were discarded because they included operational or booking-access statements that must not be presented as current policy in a simulated booking flow.
- `capacity` comes only from the related property labeled `Kapazität` when its declared type is `number` and the value is a positive integer. 6 capacities meet that rule; 24 are `null`. The source's `quantity` field and room-name text such as “2er” or “3er” were not treated as seat counts.
- `location` comes only from the related property labeled `Gebäude`, after a short plain-text check. 23 locations are included; 7 are empty strings because no safe building string was available. Address records, coordinates, and other free-form location fields were omitted.
- `features` contains only these allowlisted equipment-property labels, and only when their value signals presence:
  - `Beamer`: 2 rooms
  - `Docking Station`: 0 rooms
  - `Flip-Chart`: 2 rooms
  - `Hybride Besprechungstechnik`: 1 room
  - `Höhenverstellbarer Schreibtisch`: 24 rooms
  - `Kinderspielzeug`: 1 room
  - `Metaplanwand`: 1 room
  - `Monitor`: 23 rooms
  - `Whiteboard (Wand)`: 1 room
  - `XL-Monitor`: 1 room
  Property values are not copied into the fixture. Missing, negative, and unrecognized values do not create a feature.
- `services` contains all 9 service catalog records, using only each record's `id` and `attributes.name`. 8 catalog services are directly linked from at least one room; 1 catalog service is not linked by these 30 resources. `serviceIds` preserves every actual direct relation for each resource in source order. `serviceId` is populated only where a resource has exactly one linked service (8 rooms); it is `null` for 22 rooms with multiple linked services. Every ID in either field resolves to `services`. A demo adapter may select the first `serviceIds` entry only under its explicit synthetic policy; that choice does not establish real booking permission.

## Excluded source data

The export omits service configuration and booking rules, access credentials and tokens, personal or contact data, custom-form payloads, GPS and street-address details, all non-allowlisted properties, and booking quantity. No credential values are included. These omissions keep the fixture limited to public room-catalog information; they do not imply that the source system's booking policy was inspected or that a demo user may make a live booking.

## Snapshot limitations

The room names and selected catalog fields reflect the read-only snapshot date. Current availability, bookings, access rights, and booking eligibility are not represented. Runtime integration is not established by the presence of this fixture.
