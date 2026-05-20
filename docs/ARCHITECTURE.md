# AI Frontdesk Runtime V2 Architecture

## Scope
This document defines the initial architecture foundation for an AI-first conversational booking runtime. It intentionally excludes production implementations.

## High-Level Runtime Flow
1. **Transport input** arrives from Telegram/WhatsApp via n8n or direct adapter.
2. **Runtime API / Turn Handler** receives the turn.
3. **Session loader** fetches Contact + Case + conversation references.
4. **Truth Snapshot Builder** assembles compact business truth from Supabase/Postgres.
5. **OpenAI Responses + Conversations context** provides conversational continuity.
6. **AI Turn Planner** returns structured intent/tool request JSON.
7. **Tool Policy** allows/denies requested tools by guardrails and state.
8. **Executors** run allowed tools (`kb.search`, `availability.check`, `hold.create`, `booking.confirm`).
9. **Reply Composer** generates final assistant response.
10. **State Writer + Debug Logger** records outcomes/events.
11. **Adapter response** is sent back through transport.

## Boundary: Planner vs Backend
- Planner owns semantic interpretation and tool *requests* only.
- Planner does **not** execute tools, write DB state, or write calendar appointments.
- Backend owns policy decisions, capability boundaries, and transactional execution.
- Backend must not implement deterministic regex semantic routing or alias registries.

## Memory Layers
1. **OpenAI Conversation Memory**: semantic continuity for follow-ups and short replies.
2. **Local Business Memory (Supabase/Postgres)**: authoritative state for cases, holds, appointments, statuses.
3. **Runtime Context Builder**: combines conversation continuity with local truth snapshot per turn.

**Critical rule**: conversation memory helps understanding; business memory authorizes execution.

## Core Entity Model
- `Contact`
  - `Cases[]`
    - `Appointments[]`

A Case is not an Appointment. One Contact can hold multiple active or historical Cases (booking, FAQ, orthodontics for family member, reschedule/cancel, admin handoff).

## Truth Snapshot Contract
Runtime Context Builder produces a compact, policy-relevant snapshot for each turn:

```json
{
  "contact_id": "...",
  "case_id": "...",
  "case_status": "open | collecting | slot_offered | booked | closed | dropped",
  "lead_status": "new | qualified | booked | visited | no_show | returning",
  "booking_status": "none | availability_requested | slots_found | slot_offered | hold_active | booked | expired | cancelled",
  "service_interest": "cleaning",
  "offered_slot": {
    "slot_id": "...",
    "hold_id": "...",
    "starts_at": "2026-05-21T19:30:00+02:00",
    "ends_at": "2026-05-21T20:00:00+02:00",
    "status": "offered_not_confirmed | active_hold | expired | confirmed"
  },
  "known_patient_data": {
    "name": "Анна",
    "phone": null,
    "telegram_username": "@example"
  },
  "latest_appointment": {
    "appointment_id": "...",
    "starts_at": "...",
    "status": "booked | confirmed_by_crm | cancelled | visited | no_show"
  }
}
```

## Planner Output Contract
Planner returns structured JSON (request plan only):

```json
{
  "turn_type": "greeting | faq | booking | availability | confirmation | mixed | post_booking | reschedule | cancel | admin_request | unknown",
  "answer_needed": true,
  "kb_needed": true,
  "tools_requested": ["kb.search", "availability.check"],
  "date_intent": "today | tomorrow | weekend | specific | next_week | unknown | null",
  "time_intent": "morning | afternoon | evening | any | unknown | null",
  "booking_action": "check_availability | create_hold | confirm | cancel_hold | null",
  "reply_strategy": "answer_only | ask_clarification | answer_then_offer_slots | offer_slot_then_wait_confirmation | confirm_booking | safe_fallback",
  "kb_queries": [
    "лечение кариеса пломба терапевтическая стоматология восстановление зуба цена"
  ],
  "booking_request": {
    "service": "cleaning",
    "preferred_date_text": "tomorrow",
    "preferred_time_text": "evening"
  },
  "confidence": "high | medium | low",
  "reason": "short explanation for debug"
}
```

## Tool Policy Model
Tool policy is the runtime safety/control gate between planner intent and execution.

- `kb.search`: read-only FAQ retrieval via pgvector.
- `availability.check`: read-only slot discovery.
- `hold.create`: controlled write, creates expiring hold.
- `booking.confirm`: transactional write, only if explicit confirmation + active unexpired hold.

`admin.notify` is not an AI tool. Admin notifications are backend side effects emitted from events/logs and delivered by n8n.

## Booking Flow (MVP)
1. User requests availability.
2. Planner requests `availability.check`.
3. Tool Policy approves read-only check.
4. Booking Executor returns slots.
5. System may request/perform `hold.create` when policy allows.
6. User explicitly confirms.
7. Planner marks confirmation intent.
8. Policy allows `booking.confirm` only with active unexpired hold.
9. `booking.confirm` creates an actual booked appointment.
10. After booking success, CRM/admin follow-up may happen externally via backend event/logs and n8n.

## RAG / FAQ Flow
1. Planner decides whether FAQ grounding is needed and forms semantic `kb_queries`.
2. Backend runs retrieval with pgvector (`kb.search`).
3. AI composes grounded answer from retrieved chunks.

No deterministic regex routing. No hardcoded semantic alias tables as primary interpretation path.

## Date/Time Handling Responsibility
- AI extracts intent meaning (e.g., “tomorrow evening”, “this weekend”, “after work”).
- Backend canonicalizes and validates exact dates/ranges/timezone/business hours/slot validity.

## Debug Envelope
Each turn should emit structured runtime telemetry:

```json
{
  "trace_id": "...",
  "contact_id": "...",
  "case_id": "...",
  "turn_type": "...",
  "truth_snapshot": {},
  "planner_output": {},
  "tools_requested": [],
  "tools_allowed": [],
  "tools_denied": [],
  "tool_results": [],
  "faq_used": true,
  "retrieval_query": "...",
  "chunks_retrieved": 5,
  "used_chunk_ids": [],
  "booking_action": "...",
  "booking_result": {},
  "lead_status_before": "...",
  "lead_status_after": "...",
  "latency_ms": 1234,
  "error": null
}
```

## Extensibility: Toward Bounded Agent Runtime
Future evolution can add bounded specialized agents (e.g., FAQ grounding, booking orchestration, reschedule assistant) while preserving:
- central Tool Policy control,
- executor-only writes,
- authoritative Supabase business state,
- uniform debug envelope and replayability.
