# Stopping a generated answer

The composer offers **Antwort stoppen** while a model response is being fetched
or its body read. The control occupies the usual 44px send-button target. It
does not clear the draft. After stopping, the chat reports the stopped answer;
the user can send another message once the request has unwound. Intentional
stopping does not add a technical-error retry instruction to the conversation.

Each inference step owns a separate abort controller. Stopping aborts that
controller, not the conversation's tool/action controller. A late transport
response is checked again before its answer is rendered or any proposed tool
is dispatched. The Stop control is removed before tool processing. Existing
cards, prepared proposals and confirmed actions retain their normal lifecycle.
Stopping generation does not cancel a booking or a cancellation.

The authenticated HTTP request's abort signal propagates to the model router
and AI SDK. Intentional cancellation is distinct from provider timeouts: it
must not trigger fallback or Groq's invalid-tool regeneration. Source, account,
tool, provider and budget checks remain in force.

A request cancelled before provider dispatch may release its unused reservation.
After dispatch, missing usage remains conservatively charged through the
existing unknown-usage settlement. A trustworthy completed usage report may
settle the actual amount even when the corresponding late answer is discarded.
Cancellation does not establish that the provider did no work or charged zero.
The HTTP boundary returns a sanitized cancellation response, without exposing
the abort reason, and does not finalize a cancelled reply into host history.

Browser keyboard/focus and bounded transport tests qualify the technical
contract. Native-device and assistive-technology acceptance remain M8.
