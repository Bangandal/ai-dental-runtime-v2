# Agent-first model state surface

The patient-facing model should receive conversational evidence and semantic facts, not Runtime's hidden workflow state machines.

## Cross-turn dialogue authority

- `runtime_context.recent_history` is the dialogue-memory source.
- Provider conversation ids are turn-local transport only in `agent_first`.

## Stable first-call context

The model may see:

- `channel_context`: channel plus one weak `language_hint`.
- `runtime_context.patient_context`: patient display facts.
- `runtime_context.task_state.collected`: durable semantic facts such as known service/problem/time/contact preference.
- `runtime_context.qualification_state`: patient-reported complaint and reported facts only. Model-written summaries are Runtime/private history, not model input.
- `runtime_context.staff_request_context`: an explicit callback/document request context when one exists. A request for a doctor's direct contact details is not a callback request.
- `runtime_context.runtime_policy`: meaningful deterministic policy facts such as reachability.
- `runtime_context.recent_history`: dialogue evidence.
- `runtime_context.booking_subjects`: minimal semantic people facts needed to distinguish self vs multiple other people, such as person kind, active person, label/name and service. Booking/contact workflow state stays private.
- `booking_selection`: only when a selected exact slot has verified continuity evidence.

The model must not see as cross-turn steering:

- full `booking_process_state`;
- historical `case_context` / `booking_context` summaries;
- missing-field lists, next-action/readiness/proof state;
- old persisted clinical route/urgency/red-flag decisions;
- model-written qualification summaries;
- internal `subject_N` ids;
- raw pending typed phone ownership state;
- people phone/contact status;
- cached booked/slot state inside the people registry.

## Doctor direct contacts

The front desk never discloses a doctor's direct or personal phone, email or other contact details. A patient asking for a doctor's direct contact receives a brief refusal and that request alone does not create a `staff_request`. An explicit request for the doctor or administrator to call the patient is a separate callback intent and may create a `staff_request`.

## Tool follow-up

Within the same provider conversation, follow-up model calls receive function-call outputs and compact current-turn Runtime truth. The stable patient message/context is not replayed.

Runtime remains authoritative for booking legality, subject identity, phone ownership, slot proof, writes, locks and action outcomes. Tools remain authoritative for current clinic state.
