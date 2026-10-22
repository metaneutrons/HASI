# Exact availability-only room results

Code revision: `61d1f721923eba9f12a241d6fa3f287b8affc794`. This is bounded development evidence, not M6/M7 acceptance.

A fixed-interval search now checks at most eight native candidates in batches of three, without additional model generations. Cards require a checked available interval matching both requested endpoints. Busy, unchecked, wrong-duration and alternate-time results are excluded; pagination counts only visible vacancies. Missing time prompts contain no resource cards. A failed availability read propagates an error rather than becoming a no-vacancy claim. Truncated searches explicitly limit the claim to the checked subset.

Protected reload still clears availability and uses current authorized resource metadata. Historical candidates appear as one recheck action instead of unchecked cards. Rechecking requires their saved interval; it never borrows the current request window. Booking preparation still performs a fresh availability check and requires separate confirmation. Empty historical results retain only a fixed requery instruction, not browser-authored claims of no vacancies. Invalid date/time/duration messages now name the invalid fields; DST wording is reserved for valid but ambiguous/nonexistent Berlin civil times.

## Actual optimized browser observations

The clean committed build ran through a local TestIdP, two API replicas and an owned disposable PostgreSQL database. A 1J workplace search for 23 October, 10:00–16:00, initially returned eight bounded vacancies. One Amrum 1 booking was separately confirmed in this isolated mock. Repeating the same search showed seven vacancies and omitted Amrum 1. Reload showed no vacancy cards; one recheck restored the still-free exact intervals. The model-mode office-preference shortcut also ran native availability checks. A missing-time request showed only its signed clarification, including after reload. All test accounts were signed out; the owned tab, processes, database tree and private home were cleaned.

The runtime had no real provider credentials or real business connections. No actual LLM-generated tool call was exercised in this browser sample. The 390×844 DOM measured document width390, but the browser/CDP screenshot had inconsistent clipping/scaling and is **not accepted as mobile visual evidence**. Native device acceptance remains separate. The original user query/time is unknown; this report does not infer why the original date was invalid or how many click events occurred.

## Checks and source review

97 focused cases cover native bridge/planner, exact interval filtering, bounded concurrency and callback failures, rendered mixed/occupied/unchecked results and pagination, protected reload, empty-result projection and date/time guards. Web TypeScript and scoped ESLint pass. An independent source review identified the legacy-window fallback; requiring saved endpoints resolves it. No concrete authorization bypass or automatic alternate-time card was found. Final whole-suite pre-push/CI qualification is recorded separately.

[Result](available-room-search-result.json), [sanitized browser artifacts](available-room-search-artifacts.zip), [screenshot](available-room-search.png).
