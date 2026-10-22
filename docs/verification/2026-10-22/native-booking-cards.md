# Native own-booking cards during protected saves

Browser code: unpublished `d5ae90089d44dc8780478cde1940a6cb17406349`, mapped by entire-tree identity to `150869d846a880a5d694ccac8375542aadd06185` after rebasing only unpublished commits. Subsequent `dba8f35` separately stops further inference after a failed own-booking read; that failure branch was source/type checked, not exercised in this browser packet.

An actual optimized TestIdP/two-API/PostgreSQL browser run retained a signed empty-bookings notice through reload. After confirming one isolated setup mock booking, it held the actual nonempty workspace save and the next timestamp response, began cancellation, released the own-save acknowledgement and retained the new turn/busy state. One pending cancellation proposal appeared and survived reload. Cancellation was never confirmed. The full captured network summary has no truncation or remaining page: zero POST `/api/chat` generations (one GET navigation), no mismatch, interruption or unknown timestamp in the accepted sequence. All owned fixtures were cleaned.

Seven real protected-store/client tests cover exact ordered booking-record compatibility and rejection of changed status, interval, metadata, removal or access loss. Cosmetic text/model attribution can remain in the mounted host UI until remount; the server still canonicalizes it and it is not model context. No user or action authorization is created by matching IDs. No real credentials, rights or writes and no general M6/M7 acceptance.

[Sanitized artifacts](native-booking-cards-artifacts.zip).
