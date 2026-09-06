# Patient context and staff requests

The September screenshot replay exposed two kinds of failure: the model lost the
meaning of dates/people, and a promise to pass a request to staff had no associated
operation. Agent-first instructions now distinguish birthdays, callback windows,
visit preferences and durations; preserve each person's plan; acknowledge patient
reports; and require verified price/location/insurance facts.

## Runtime request path

The main model can propose a typed `staff_request` in its final JSON envelope, along
with qualification state. Its allowed kinds are `callback` and `document_update`.
The shared orchestrator validates the proposal and uses the canonical clinic,
contact and trace supplied by the inbound pipeline. It never accepts these IDs,
delivery success, diagnoses or a doctor's review as facts supplied by the model.

Runtime first creates a row in `core.staff_requests`. Only the creator of that row
may invoke the configured admin notifier. The unique clinic/contact/trace key and
existing inbound-event dedupe prevent a duplicate delivery of the same turn. The
notification includes the full patient-reported summary, person, request ID and
preferred callback window. Appointment dates/times stay empty for this operation.
Additional patient messages create additional auditable request rows, containing
the updated summary; they do not silently overwrite earlier requests.

Runtime records the delivery result on the request. The outward reply is a short
execution receipt, localized to the validated conversation language. `sent` allows
confirmation of delivery to staff. `queued`, `failed`, `disabled`, `not_configured`
and an unresolved `pending` do not allow that claim. None of these outcomes proves
that a doctor will call at a particular time, received an image or reviewed it.

The receipt is generated before the existing assistant-message persistence step,
so the saved message, HTTP reply and patient transport receive the same text.
Structured request and delivery proofs appear in the ordinary side-effect log.
The last request's purpose and callback window are also saved in conversation
context to interpret a later short reply such as `10–11` correctly.

## Apply and verify

Apply `sql/rpc/core.staff_requests.sql` using the deployment's normal privileged
migration process before deploying this code. The active RPC client uses the
`core` schema. No patient/appointment tables or existing booking policy change.
The new table has RLS enabled and RPC execution is limited to `service_role`.
Until the migration exists, a request fails closed with an honest failure receipt
and no notification attempt. Ordinary turns are unaffected.

Use the existing `ADMIN_NOTIFY_MODE`, admin chat and bot configuration. No real
patient or staff messages are needed for the local tests; notifier transports are
injected fakes. Test `tests/staffRequest.test.ts` checks normalization through the
real caller/service, persistence-before-delivery, failure and duplicate behavior,
shared orchestration, language, next-turn context and actual notification content.

`evals/dental-dialogue-regressions-v1.json` defines model replays with complete
context and fixed clocks. These are acceptance cases, not assertions that a live
model has already passed them. Unit tests with model responses supplied as fixtures
prove Runtime behavior, not language-model understanding.

## Operational limits

The durable request is independent of delivery success. If a process stops after
creation but before recording delivery, its `pending` outcome needs operator
reconciliation. Automatic retries are deliberately absent because Telegram send
does not provide an idempotency guarantee; a duplicate request never silently
resends. Actual delivery with a failed audit write remains visible in turn logs.
Staff acknowledgment, completion and scheduled-callback execution remain manual.

The execution receipt replaces the model acknowledgement on request turns. Answers
to other questions can be provided through `staff_request.additional_reply` and
are appended to that receipt. As with ordinary model answers, those answers must
be grounded in context/tools and must not claim execution outcomes. They are not
used as delivery proof or as instructions to the notifier.
