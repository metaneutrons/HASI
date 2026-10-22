# Historical shared-budget prefix reconstruction

This read-only follow-up adds evidence to the [PR #218 budget-value difference](https://github.com/metaneutrons/HASI/pull/218#issuecomment-6337599118).
It does not change the earlier failed strict unchanged-budget assertion into a
pass or identify the exact intermediate state observed after that deployment.
The [machine result](budget-prefix-retention-result.json) records the controls,
snapshot identities, matching states and explicitly bounded conclusions.

## Actual observation and controls

The trusted server operator reads the existing PostgreSQL budget row and the
two retained pre-delivery snapshots, without model credentials or model calls.
Its only database command is a static `SELECT`. Candidate states are copied and
modified in process memory; none is written back to the database. The detached
audit completed with exit 0; its exact source SHA-256 is
`97f1d093f709cc8400f9fe7f4d0f8a1a5f181f24b5d6e4fb3c8139da5561921e`.

The auditor orders JSON object keys using PostgreSQL JSONB's byte-length/byte
ordering and reproduces the **actual current** `md5(value::text)` before admitting
the comparison. A one-micro-USD alteration fails that same comparison. It also
checks that current-window input/output/cost counters equal retained charges.
It searches retained reservation prefixes, subtracting only removed
current-window charges, with explicitly enumerated last-entry status variants.
Each target matches the exact-prefix candidate; no status alternative is needed.

| Retained snapshot | Reservations | Settled / unknown | Input tokens | Output tokens | Charged micro-USD |
| --- | ---: | --- | ---: | ---: | ---: |
| Before PR #218, 09:14:51.126 UTC | 70 | 66 / 4 | 134,128 | 5,722 | 130,219 |
| Before PR #219, 09:51:35.994 UTC | 72 | 68 / 4 | 139,885 | 5,841 | 135,302 |

The current readback retains 92 reservations and 168,440 charged micro-USD.
The two additional settled entries contain 2,564 input/73 output tokens charged
at 2,344 micro-USD, and 3,193/46 at 2,739 micro-USD. Their **5,757 input tokens,
119 output tokens and 5,083 micro-USD** exactly reconcile the two snapshot
counters. Each charge matches the shared policy's separate input/output ceiling
at USD 0.80/4.00 per million tokens. This is ledger accounting, not a provider
invoice or a new determination of provider prices. The later 33,138-micro-USD
difference is independently recorded by the [20-request M6 observation](injection-gaps.md).

## Conclusion and limits

The current retained ledger contains all 70 earlier reservations, including the
four unknown holds. Their reconstructed state and counters match the earlier
snapshot digest; the later snapshot includes two further settled entries that
account for its increase. No reset or refund is visible in these reconstructed
states. Later unchanged-delivery proofs alone did not establish this result.

The exact post-#218 intermediate value/digest was not preserved. The ledger has
no caller identities or individual reservation timestamps. This audit therefore
does **not** place the two settlements before the 09:28 delivery observation,
attribute them to specific callers/provider requests, or prove that no temporary
reset/refund happened at any intermediate time. Search uniqueness is bounded to
the stated candidate construction, not all imaginable histories.

Two extended SSH observations timed out before yielding usable results. A first
detached-launch bootstrap had a syntax error before execution; it created no
audit directory or database effect. The corrected bootstrap was syntax-checked
locally, launched once with its own process/artifact handle, and its completed
result was read back. None of these attempts changed a budget or issued a model
call. An independent source/result review confirmed the arithmetic and these
scope limits. This is additional M7 durability evidence; M6/M7 acceptance and
non-deferred human answer review remain separate.
