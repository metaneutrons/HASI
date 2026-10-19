# Native historical results and missing Apps view

Date: 2026-10-19. Bounded P3-A4 browser evidence, not complete P6/M7 or
institutional acceptance. The public Apps flag remains off.

The temporary loopback harness compiled the actual `Conversation` and its
rendering dependencies from `255afe8876eb46685d005a1fb6cee4856cdb48fb`,
with only an export transformation and a plain-anchor replacement for Next Link.
The component file SHA-256 is
`f050022da9e6f1c3c429ffba8b9c03808ddb1eab91efc007c2b5808bfcf29c6f`.
Two bundles set the compile-time Apps flag to 0 and 1. No third-party HTML or
external service was hosted or contacted; this does not admit an external App.

A synthetic persisted workspace uses the real `chatStorageKey`,
`saveChatWorkspace` and parser: two messages, one historical checked workplace
result, and citation `knowledge:service_it:svc-001:1`. The fixture workplace
`Demoarbeitsplatz B-4.12` is in a shared four-workplace office, with the
March 3, 2027 10:00–11:00 slot. Its action control is disabled. The source card
links to a local source handler; no source document is available in the harness.

Root's in-app Chromium observations:

- With Apps off at 390 CSS pixels/light, the stored transcript, workplace card
  and source card render and survive iframe reload.
- With Apps on at 320 pixels/dark, the same native content remains. Opening
  the interactive view makes one local resource GET returning 404; the
  unavailable-view message and native fallback appear. The safe error text is
  shared with 403, so its wording alone does not identify the HTTP status.
- Clicking the actual source link opens a local 403 page containing only a
  generic denial, without document metadata or source body. It does not prove
  institutional authorization or erase previously seen local history.
- Reload retains two messages, one room result, one citation and the 2,949-byte
  stored snapshot. Observed counters after the interaction/reload sequence:
  five API GETs, one view 404, one source 403; zero API/model/tool/action POSTs.
  Unknown routes return 404; there is no proxy or executing backend.
- At 320 pixels the body client/scroll widths are both 320 and no rendered
  descendant extends past the content boundary. The iframe's document client
  width is 318 and document scroll width 320; this is a bounded layout reading,
  not a claim of a complete responsive or native-device matrix.

The persistence helper's Node smoke check seeds once, then reuses exact stored
bytes without a second write through the production workspace parser. The
browser harness reports one local snapshot metadata rewrite: its JSON-string
comparison treats schema key order and the component effect's key order as
different. This is an instrumentation limitation; message/card/citation values
remain intact. It is not a tool or business action. No zero-local-write claim
is made.

The isolated harness used port 56975, then was stopped and the listener verified
closed. Temporary source identities: `entry.tsx` SHA-256
`952180d7dbcfed4b39be9c49e19f3fd1a9e9aad31b9945da7bb5e1b8d9d61923`;
`history-fixture.ts`
`a6aabada23f819dd399a54d83f8d8579840160f7038feae56d5868fce966aaa8`;
`serve.mjs`
`c17bc58ac763c3fbfffe4089302065965eedffbfd65b43792a64118d990b9be0`.
It used synthetic identity/timestamps/session responses and is not the actual
Next deployment, account lifecycle, full access-revocation flow, native hardware
or assistive-technology acceptance.
