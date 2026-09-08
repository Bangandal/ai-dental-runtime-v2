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
- `runtime_context.qualification_state`: patient-reported complaint/facts/summary only.
- `runtime_context.staff_request_context`: patient-reported callback/document purpose/person/window.
- `runtime_context.runtime_policy`: meaningful deterministic policy facts such as reachability.
- `runtime_context.recent_history`: dialogue evidence.
- `runtime_context.booking_subjects`: semantic people facts without internal ids, missing/readiness state or raw pending phone.
- `booking_selection`: only when a selected exact slot has verified continuity evidence.

The model must not see as cross-turn steering:

- full `booking_process_state`;
- historical `case_context` / `booking_context` summaries;
- missing-field lists, next-action/readiness/proof state;
- old persisted clinical route/urgency/red-flag decisions;
- internal `subject_N` ids;
- raw pending typed phone ownership state.

## Tool follow-up

Within the same provider conversation, follow-up model calls receive function-call outputs and compact current-turn Runtime truth. The stable patient message/context is not replayed.

Runtime remains authoritative for booking legality, slot proof, identity/contact ownership, writes, locks and action outcomes. Tools remain authoritative for current clinic state.
