# Guard unacknowledged protected chat changes before leaving

Date: 2026-10-21. Base: `5218d6283b07dbf1d50e2b9a6abc5922e12905ad`.
Supports the M2/P6 and M7 technical navigation/recovery gates; it does not accept either milestone.

Protected OIDC workspaces deliberately use memory plus server-side CAS, rather
than browser-persisted protected content. Previously their 180 ms debounce and
async PUT could race a full reload without a warning. A source-reader SPA return
worked, but that did not prove immediate hard-navigation safety.

The account-bound guard now subscribes synchronously to the store. Publishing an
edit schedules its pending timer before notifying subscribers, so the guard is
installed before that edit returns. Debounced/in-flight changes and failed or
conflicting storage state request the browser's normal leave-page confirmation.
A current acknowledgement removes the listener. Visibility hidden/pagehide flush
only existing debounced work; repeated events do not enqueue duplicate PUTs.
Disposal removes handlers without starting an old-account save. The redundant
protected-provider cleanup save is removed. Protected payloads, authorization,
CAS and explicit action confirmation are unchanged.

## Observed browser journey

The optimized local TestIdP/two-API/PostgreSQL composition ran in Chromium
155.0.0.0, in-app browser, at 390 × 844 with mobile viewport emulation. It used
synthetic identities and no model provider credentials. The reference plugin
was the workspace fixture; this run is not external distribution evidence.

1. Browser network emulation made the actual workspace PUT fail with
   `net::ERR_INTERNET_DISCONNECTED`. The storage-error notice appeared while the
   unsent composer text remained visible.
2. An actual reload request emitted `Page.javascriptDialogOpening` with type
   `beforeunload`. The browser harness automatically dismissed it, recording
   `Page.javascriptDialogClosed` with `result: false`. The old document and
   visible draft remained. This is event/canceled-navigation evidence, not a
   screenshot or manual acceptance of the browser-owned dialog.
3. After network restoration, the visible retry action completed GET 200 and
   PUT 200. A subsequent full reload emitted no dialog, navigated once, and
   restored the identical draft from the server.
4. The draft marker was absent from both localStorage and sessionStorage.
   Document width and scroll width were both 390 px. The screenshots show the
   [offline retained draft](protected-draft-offline-retained.png) and
   [server-restored draft](protected-draft-reloaded-draft.png).

The initial fixture startup terminated at its web-build stage; its suppressed
child output does not establish a more specific cause. The exposed web type
error in the test visibility stub was corrected, a separate optimized build
passed, and the next complete fixture startup and browser journey passed. No
live process was restarted merely because a status read timed out.

## Verification and limits

Five focused files / 66 tests pass, including first-edit-before-debounce,
in-flight acknowledgement, newer draft during older acknowledgement, failed
save, CAS conflict, hidden/pagehide coalescing, clean unload and account disposal.
Affected lint, web types and the optimized build pass. Independent bounded source
review found no remaining actionable issue after removing teardown-triggered
saves. Required full local and hosted CI results remain separate PR gates.

Fixture statistics report zero synthetic model calls, real provider calls,
source writes or action journals. After normal process shutdown, six exact-owned
state rows were removed; 29,270 other rows retained the same fingerprint. The
caller database was retained, isolated HOME removed, network/viewport overrides
cleared and the owned browser tab closed. The machine result retains source
hashes, build ID, request/dialog observations, screenshot digests and cleanup.

A browser may suppress beforeunload or omit lifecycle events, especially on a
mobile OS kill. A user who confirms departure can still lose unacknowledged
input; there is no unload-delivery, offline persistence or process-kill durability
guarantee. No deprecated returnValue compatibility shim is used. Native devices,
software keyboards, assistive technology and institutional acceptance remain M8;
the full technical chat/admin/error matrix remains open. This bounded guard
must not be described as universal draft durability.

[Machine evidence](protected-draft-navigation-result.json).
