# Unified Turn Classifier v1

## Goal
Define the target contract for a future Unified Turn Classifier that can replace the current two-step `runtime_gate` plus `turn_understanding` LLM path with one classifier call.

This document is a planning and contract artifact only. It does not activate a prompt, change routing, add a model call, alter persistence, or modify the Main Agent.

## Scope
- Define the target output shape for the future unified classifier.
- Preserve the current separation between route-level screening and operational turn understanding in one typed object.
- State safety invariants that downstream runtime code must enforce before any future adoption.
- Document how topic memory may and may not influence service understanding.

## Non-goals
- No runtime behavior changes.
- No classifier replacement.
- No prompt activation.
- No database changes.
- No Main Agent changes.
- No routing changes.
- No new LLM calls.
- No case, appointment, hold, notification, or booking mutation authority.

## Current Runtime Call Count Context
After PR77 and PR78, the runtime LLM call contour is:

| Turn class | Current calls |
| --- | --- |
| FAQ / non-operational | `runtime_gate` + `main_agent` = 2 |
| Booking / operational | `runtime_gate` + `turn_understanding` + `main_agent` = 3 |

The legacy case router is disabled by default and is not part of this target contract.

## Target Responsibility
The future Unified Turn Classifier should output both decisions that are currently split across two classifier boundaries:

1. **Route-level decision** currently owned by `runtime_gate`.
2. **Turn understanding decision** currently owned by `turn_understanding`.

The unified classifier is still only a classifier. It must not write cases, appointments, slot holds, notification records, or any other backend state. Any future consumer must treat the output as model-suggested classification data that remains executor-controlled and policy-gated.

## Target Output Shape

```json
{
  "route": "non_operational | operational_candidate",
  "turn_shape": "greeting | faq | mixed | booking | availability | slot_fragment | reschedule | cancel | urgent | admin_request | follow_up | process_status_inquiry | postpone | confirmation_response | unclear | other",
  "turn_type": "booking_request | availability_request | slot_fill | reschedule | cancel | urgent | admin_request | follow_up | process_status_inquiry | postpone | confirmation_response | mixed | faq | greeting | other | unknown",
  "topic": "string or null",
  "service_interest": "string or null",
  "subject": {
    "kind": "self | child | family_member | other | unknown",
    "display_name": "string or null"
  },
  "reply_objective": "answer | ask_missing_field | offer_next_step | explain_status | handoff | clarify | safe_fallback",
  "case_decision": {
    "action": "none | continue_existing | open_new | update_existing | close | handoff",
    "case_kind": "booking | reschedule | cancel | urgent | admin | follow_up | process_status | unknown | null",
    "target_case_id": null
  },
  "slot_updates": {
    "service_interest": "string or null",
    "preferred_date": "string or null",
    "preferred_time": "string or null",
    "first_name": "string or null",
    "last_name": "string or null",
    "offered_slot_id": "string or null",
    "confirmation_target": "string or null"
  },
  "missing_fields": ["field names still needed before a next operational step"],
  "confidence": "low | medium | high",
  "reason": "short explanation for trace/debug",
  "should_apply": false
}
```

## Field Semantics

### `route`
The route-level screening decision:

- `non_operational`: The turn is answerable or acknowledgeable without operational workflow handling.
- `operational_candidate`: The turn may require booking, reschedule, cancellation, urgency, admin handling, case continuity, slot collection, or process-status handling.

### `turn_shape`
A compact route-facing shape compatible with the current runtime gate boundary. It is useful for coarse routing and diagnostics.

### `turn_type`
The operational or conversational intent compatible with the current turn-understanding boundary. It is more workflow-oriented than `turn_shape`.

### `topic` and `service_interest`
`topic` is a general subject such as price, location, insurance, cleaning, or wisdom teeth. `service_interest` is the specific service the user is trying to book, check availability for, reschedule, or otherwise operationalize.

### `subject`
The patient or affected person inferred from the turn. This is descriptive context only and does not create or update patient records.

### `reply_objective`
The suggested patient-facing objective for the next reply. It must not grant write authority to the Main Agent.

### `case_decision`
A draft case-level suggestion. It is never self-applying. `target_case_id` is fixed to `null` for this v1 target contract because case targeting must remain runtime-owned and backed by trusted context rather than model-selected identifiers.

### `slot_updates`
Extracted slot-like values from the user turn. These are proposed facts for downstream validation, not confirmed appointment or hold facts.

### `missing_fields`
Operational fields still needed before a next safe workflow step. In messenger-first flows, `phone` must not appear in `missing_fields`.

### `confidence` and `reason`
Traceability fields for debugging and future rollout monitoring.

### `should_apply`
Must always be `false`. The classifier has no authority to apply route changes, case updates, booking actions, appointment writes, or notification side effects.

## Contract Rules

1. `should_apply` must always be `false`.
2. `missing_fields` must never contain `phone`.
3. For `non_operational` FAQ or greeting turns, `case_decision.action` must be `none`.
4. For `non_operational` FAQ or greeting turns, `missing_fields` must be an empty array.
5. `case_decision.target_case_id` must always be `null`.
6. Current explicit `service_interest` in the user turn beats `topic_memory`.
7. `topic_memory` may be used only as a contextual hint for booking or availability turns when the user provides no explicit `service_interest` in the current turn.
8. The classifier has no case, booking, appointment, hold, admin-notification, or other mutation authority.
9. All future write actions must remain executor-controlled and policy-gated.
10. Admin notifications remain backend side effects emitted as events/logs and handled outside the Main Agent path.

## Topic Memory Rule
Topic memory can improve continuity, but it must not override the current user turn.

Allowed use:

- Previous topic memory says `cleaning`.
- Current turn says, "Can I book tomorrow?"
- Because there is no explicit service in the current turn, the classifier may use topic memory as a contextual hint and set `service_interest` to `cleaning` with appropriate confidence.

Forbidden use:

- Previous topic memory says `cleaning`.
- Current turn says, "Can I book whitening tomorrow?"
- The current explicit `service_interest` is `whitening`; the classifier must not overwrite it with `cleaning`.

## Example: Non-operational FAQ

```json
{
  "route": "non_operational",
  "turn_shape": "faq",
  "turn_type": "faq",
  "topic": "cleaning price",
  "service_interest": null,
  "subject": {
    "kind": "unknown",
    "display_name": null
  },
  "reply_objective": "answer",
  "case_decision": {
    "action": "none",
    "case_kind": null,
    "target_case_id": null
  },
  "slot_updates": {
    "service_interest": null,
    "preferred_date": null,
    "preferred_time": null,
    "first_name": null,
    "last_name": null,
    "offered_slot_id": null,
    "confirmation_target": null
  },
  "missing_fields": [],
  "confidence": "high",
  "reason": "The user asks an informational price question without requesting an operational workflow.",
  "should_apply": false
}
```

## Example: Operational Booking Candidate

```json
{
  "route": "operational_candidate",
  "turn_shape": "booking",
  "turn_type": "booking_request",
  "topic": null,
  "service_interest": "cleaning",
  "subject": {
    "kind": "self",
    "display_name": null
  },
  "reply_objective": "ask_missing_field",
  "case_decision": {
    "action": "open_new",
    "case_kind": "booking",
    "target_case_id": null
  },
  "slot_updates": {
    "service_interest": "cleaning",
    "preferred_date": null,
    "preferred_time": null,
    "first_name": null,
    "last_name": null,
    "offered_slot_id": null,
    "confirmation_target": null
  },
  "missing_fields": ["preferred_date", "preferred_time", "first_name", "last_name"],
  "confidence": "high",
  "reason": "The user asks to book a cleaning but has not provided date, time, or name details.",
  "should_apply": false
}
```

## Future Adoption Notes
A future implementation may add a prompt and runtime integration that emits this shape in place of separate `runtime_gate` and `turn_understanding` classifier calls. That future PR must include runtime wiring, rollout controls, and additional tests proving that behavior is unchanged or intentionally gated. This v1 contract does not perform that migration.
