# Demo health qualification counterprobe

The public health workflow has an opt-in technical counterprobe for the M7
monitoring exercise. A manual dispatch on `main` runs the regular public probe
first. When `qualification_counterprobe` is set to `true`, a separate, explicitly
named job then invokes the same fixed-endpoint monitor with an all-zero expected
revision. With a deployed revision different from that sentinel, the counterprobe
must exit with code 1 and the sanitized code `revision_mismatch`. If the endpoint
reports the all-zero sentinel, the exercise is unqualified and must not be
recorded as a demonstrated failure path.

The input defaults to `false`. Scheduled runs and ordinary manual dispatches
retain their existing probe behavior. The new procedure document is included in
the push and pull-request path filters. The exercise
uses no credentials, caller-selected origin, retry, or public write.

The planned evidence sequence is a failed synthetic counterprobe, a named
technical operator's observation and acknowledgement record, then a normal
manual dispatch with the input left `false` that completes green. The expected
failure happens only after the regular public probe succeeds. A synthetic
`revision_mismatch` checks the monitor's comparison and visible workflow failure
path; it is not evidence of an outage or HTTP 503. It does not test notification
delivery or establish human institutional acceptance. An operator must record
the observation and acknowledgement separately; this document records neither.

This is a procedure for a planned M7 technical exercise. No counterprobe run,
operator acknowledgement, recovery run, or institutional acceptance is
evidenced here. M8 participation by actual institutional users remains open.
