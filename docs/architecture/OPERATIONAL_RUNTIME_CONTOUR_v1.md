# Operational Runtime Contour v1

## Goal
This document captures the next runtime architecture direction before implementation. It is a planning artifact only and does not change runtime behavior.

## Scope
- Define the target contour for separating light non-operational turns from operational workflow candidates.
- Clarify case-opening boundaries, memory updates, routing responsibilities, and reply context preparation.
- Identify legacy cleanup notes for the current shadow case router contour.

## Non-goals
- No runtime behavior changes.
- No schema, API, executor, prompt, or transport changes.
- No new semantic alias registry or regex-based routing implementation.
- No appointment write path changes.

## Current Foundation
The current foundation already establishes the durable runtime layers that the next contour should preserve:

1. **Base Runtime**
   - Owns the turn lifecycle and coordinates runtime services.
   - Preserves executor-controlled writes and policy-gated side effects.

2. **Memory hydration**
   - Hydrates conversational and business context before the model-facing step.
   - Supplies continuity without treating model memory as business truth.

3. **KB**
   - Provides retrieval-backed information for FAQ and service information answers.
   - Remains read-only and grounded in clinic/business knowledge.

4. **Unified persistence/logging**
   - Records turn outputs, decisions, tool activity, and operational events in a consistent envelope.
   - Supports traceability, replay, and debugging.

5. **Main agent**
   - Produces patient-facing language.
   - Should remain the voice layer, not the owner of operational state transitions.

6. **Current shadow case router**
   - Exists as a legacy experimental contour.
   - Should not be treated as the final runtime architecture.
   - Its decision shape is useful for learning but too narrow for the next operational runtime boundary.

## New Target Architecture
The target architecture introduces a lightweight screening boundary before operational enrichment. The purpose is to avoid opening operational cases for non-operational turns while still allowing lightweight topic memory updates.

```text
Inbound Turn
  -> Base Runtime
  -> Runtime Gate / Light Screening
       -> Route A: Non-operational
       -> Route B: Operational Enrichment
            -> Turn Understanding
            -> Decision Router
            -> Reply Context Builder
  -> Main Agent
  -> Persistence
  -> Outbound Reply
```

### 1. Base Runtime
The Base Runtime remains the coordinator for a single turn. It loads available context, invokes the runtime gate, coordinates route-specific processing, invokes the main agent for final wording, and persists the turn outcome.

### 2. Runtime Gate / Light Screening
The Runtime Gate performs a minimal early classification:

- Is this turn clearly non-operational and answerable without an operational case?
- Is this turn a candidate for an operational workflow?
- Is confidence too low and therefore safest to send through operational enrichment without applying writes?

The gate must stay lightweight. It should not become a semantic catch-all, a regex router, or a hardcoded alias registry.

### 3. Route A: Non-operational
Route A handles lightweight conversational and informational turns. It does not open a case. It may update topic memory when useful for continuity.

### 4. Route B: Operational Enrichment
Route B handles candidates that may involve workflow state, case continuity, slot collection, booking/reschedule/cancel flows, urgent handling, admin escalation, or process status.

Route B does not mean a write is authorized. It means the turn requires operational understanding before the runtime decides what may happen.

### 5. Turn Understanding
Turn Understanding is the next-generation decision object for operational candidates. It should describe the turn, known subject, user objective, possible case decision, slot updates, missing fields, confidence, and reason.

This output is a draft decision object. It must default to `should_apply: false` until the runtime policy layer decides whether and how to apply any state changes.

### 6. Decision Router
The Decision Router consumes Turn Understanding and determines the safe runtime path, such as:

- continue current case,
- open a new operational case,
- update existing case metadata,
- ask for missing fields,
- call a read-only tool,
- prepare a handoff/admin event,
- or respond without operational mutation.

The Decision Router coordinates decisions; it does not replace executor policy or backend proof requirements.

### 7. Reply Context Builder
The Reply Context Builder converts runtime decisions and known truth into constrained instructions for the Main Agent. It should tell the Main Agent what to say, what is known, what is missing, and what must not be claimed.

### 8. Main Agent
The Main Agent is the voice layer only. It composes a patient-facing response from the reply context, KB snippets, and safe runtime instructions. It does not own case state, appointment state, write authorization, or backend side effects.

### 9. Persistence
Persistence records the turn, route, decisions, memory updates, tool activity, and reply. The database remains the source of truth for operational state, cases, appointments, and confirmed backend outcomes.

## Route A: Non-operational
Route A handles turns that can be answered or acknowledged without opening an operational workflow case.

### Route A turn examples
- `greeting`
- `thanks`
- `pure FAQ`
- `price question`
- `location`
- `insurance`
- `general service info`

### Route A case boundary
Route A does **not** open a case.

A user asking a general question about services, prices, location, insurance, or clinic information is not yet in an operational workflow. If the same user later asks to book, reschedule, cancel, handle urgency, or complete an operational step, the runtime can route that later turn to Route B.

### Route A topic memory updates
Route A may update `topic_memory` for continuity, including:

- `last_discussed_topic`
- `last_service_interest`
- `faq_category`

These updates are lightweight memory updates, not case creation. They help the runtime understand future follow-ups such as “how much is it?” or “can I book that?” without treating every FAQ as a case.

## Route B: Operational Enrichment
Route B handles turns that may require workflow state, a case decision, a tool decision, or backend proof.

### Route B operational candidates
- `booking_request`
- `availability_request`
- `slot_fill`
- `reschedule`
- `cancel`
- `urgent`
- `admin_request`
- `follow_up`
- `process_status_inquiry`
- `postpone`
- `confirmation_response`

### Route B case boundary
Route B is the only route that may lead to an operational case decision. Even in Route B, case creation or mutation must be explicit, policy-gated, and persisted by the runtime/backend rather than directly performed by the Main Agent.

## Turn Understanding Output Draft
The draft Turn Understanding object should be structured and typed. It should be expressive enough to replace the narrow legacy case router decision shape.

```json
{
  "turn_type": "booking_request | availability_request | slot_fill | reschedule | cancel | urgent | admin_request | follow_up | process_status_inquiry | postpone | confirmation_response | mixed | unknown",
  "topic": "short natural-language topic or null",
  "service_interest": "specific service interest or null",
  "subject": {
    "kind": "self | child | family_member | other | unknown",
    "display_name": "patient or subject name if known, otherwise null"
  },
  "reply_objective": "answer | ask_missing_field | offer_next_step | explain_status | handoff | clarify | safe_fallback",
  "case_decision": {
    "action": "none | continue_existing | open_new | update_existing | close | handoff",
    "case_kind": "booking | reschedule | cancel | urgent | admin | follow_up | process_status | unknown | null",
    "target_case_id": "case id or null"
  },
  "slot_updates": {
    "preferred_date": "date/range text or null",
    "preferred_time": "time/range text or null",
    "offered_slot_id": "slot id or null",
    "confirmation_target": "hold/slot/appointment reference or null"
  },
  "missing_fields": ["field names still needed before next operational step"],
  "confidence": "high | medium | low",
  "reason": "short explanation for trace/debug",
  "should_apply": false
}
```

### Turn Understanding rules
- `topic` and `service_interest` are separate fields.
- `case_decision` is not automatically applied.
- `slot_updates` describe extracted preferences or references, not confirmed appointment facts.
- `missing_fields` should be operationally relevant, not generic conversational curiosity.
- `should_apply` must remain `false` in the draft object until runtime policy validates the decision.

## Reply Context Builder Output Draft
The Reply Context Builder should produce constrained context for the Main Agent.

```json
{
  "what_to_do": "patient-facing objective for this reply",
  "what_is_known": ["facts the agent may rely on"],
  "what_is_missing": ["fields or confirmations still needed"],
  "do_not_ask": ["questions the agent should avoid repeating"],
  "do_not_promise": ["claims the agent must not make"],
  "do_not_confirm": ["appointments, holds, or workflow outcomes not proven by backend"],
  "safety_constraints": ["policy and channel constraints that must shape the reply"]
}
```

### Reply Context Builder rules
- It should be derived from runtime truth, Turn Understanding, KB results, tool results, and policy decisions.
- It should minimize ambiguity for the Main Agent.
- It should prevent unsupported claims such as confirmed bookings without backend proof.
- It should preserve channel-specific requirements, including messenger flows where phone is not required unless a later backend process explicitly requires it.

## Invariants
These invariants must hold across the target contour:

1. **FAQ does not open case.**
2. **FAQ can update topic_memory.**
3. **Case = operational workflow only.**
4. **Appointment != Case.**
5. **Main Agent is voice layer only.**
6. **Runtime coordinates decisions.**
7. **DB is source of truth.**
8. **Phone is not required for messenger channels.**
9. **Booking is never confirmed without backend proof.**
10. **Topic != service_interest.**

## Legacy Cleanup Notes
- `Old CaseRouterDecision` is too narrow for the target operational contour.
- `case_type` must not become a universal semantic container.
- The current case router shadow should be treated as an experimental legacy contour.
- The future direction is `TurnUnderstandingDecision`, with a broader typed shape that separates turn type, topic, service interest, subject, reply objective, case decision, slot updates, missing fields, confidence, reason, and apply safety.

## Implementation Notes for Future Work
When this contour is implemented, the work should remain incremental:

1. Add typed contracts for Runtime Gate, Turn Understanding, and Reply Context Builder.
2. Keep Route A read-only except for explicit lightweight `topic_memory` updates.
3. Keep Route B decisions policy-gated and executor-controlled.
4. Persist route and decision traces for auditability.
5. Replace the legacy shadow case router only after the new contour is observable and validated.
