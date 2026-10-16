# GWDG exploratory runtime observations

Date: 2026-10-16. These are exploratory probes on synthetic data, not a scored
benchmark or approval for institutional data. Model: `qwen3-30b-a3b-instruct-2507`.
Adapter: `@ai-sdk/openai-compatible@3.0.69`; temperature 0.2; max output 1,536.

## Positive cases

Protected Preview at source `7bcf92603863f3c8fb6f343d3cfe15d52ac7dc87`
passed a native `knowledge_search` call, a backend retrieval and an answer
containing the actual `demo:knowledge:service-it:001` citation. A separate
explicit room-search prompt produced `anny_search_resources` with capacity 4,
and a subsequent turn summarized the supplied authorized room results.
Production at main `489de2c6e20cbc9ea06bc3708506e0b999ce2c4b` answered a
short introductory question in the mobile browser.

## Grounding failure

In that Production chat, after the introductory exchange, the student persona
asked: “Wie prüfe ich den fiktiven WLAN-Zugang Morgenstern-Lab? Nutze die
Demoquellen und nenne die Quellenkennung.”

Expected: invoke `knowledge_search`, retrieve the accessible synthetic WLAN
source, and cite its exact identifier. Observed: no tool event or source card;
the answer asserted that no information was available and emitted the invented
identifier `[citationId=DEMO-WLAN-001]`. The actual fixture is accessible to the
student and has a different identifier. Classify this as a tool-selection and
grounding failure, not a successful source lookup.

HASI therefore exposes this model as an experimental comparison profile. It is
not the default. Trusted source links are created from validated tool results;
model prose cannot create an authorized source card or execute a booking. This
boundary does not make an unsupported written answer correct. Add the case to
the repeated evaluation set and measure tool-use recall, citation validity and
answer support before considering general-user approval.

## Availability observations

Some Qwen requests failed, while identical adapter paths passed other probes.
The former 20-second generation budget was insufficient for some longer turns;
the GWDG profile now permits 45 seconds. This is not an established reliability
or latency result. Initial GWDG GPT-OSS 120B calls repeatedly returned upstream
HTTP 500, including a short-text request; that profile is excluded until
runtime qualification succeeds. No upstream root cause is established.
