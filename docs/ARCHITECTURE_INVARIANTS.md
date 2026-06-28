# Architecture Invariants

These rules are permanent. Any PR that violates them must be rejected regardless of test coverage.

## 1. This is a stateful AI runtime, not a chatbot

The runtime maintains per-contact state: conversation memory, case context, booking state, topic memory, and conversation state. Every turn is an atomic operation on that stateful context. "Stateless chatbot" patterns (pass history in the request, call LLM directly, return reply) are incorrect and forbidden.

## 2. Transport adapters are thin shells

Telegram, WhatsApp, n8n, webchat, and any other transport channel are **thin shells only**. They are responsible for:
- Authenticating the inbound request
- Parsing the channel-specific wire format
- Routing to `runRuntimeTurnOrchestrated`
- Forwarding the reply back to the channel

Transport adapters must not own memory, case state, booking state, or any business truth. All business logic lives in the orchestrator and the RPC/Supabase layer.

## 3. All patient messages must pass through the shared stateful runtime pipeline

The canonical pipeline is `runRuntimeTurnOrchestrated` in `src/runtime/runtimeTurnOrchestrator.ts`. Every inbound patient message from any channel must go through this pipeline. This guarantees:
- Contact persistence (get or create)
- Inbound event registration (with update_id/message_id dedupe)
- User message persistence
- OpenAI conversation memory load
- Case context load
- Runtime context load
- LLM call via RuntimeTurnService.runTurn
- OpenAI conversation memory save
- Assistant message persistence
- Conversation state merge

## 4. RuntimeTurnService.runTurn is not a transport entrypoint

`RuntimeTurnService.runTurn` is the LLM call layer — it takes a fully-assembled `RuntimeTurnInput` and returns the model's response. Transport adapters must never call it directly. Only `runRuntimeTurnOrchestrated` calls it, after completing all persistence and context steps.

## 5. OpenAI is perception/reply/tool-calling only — not business truth

The LLM produces replies and tool call decisions. It is not the source of truth for:
- Whether a patient is booked
- Which slots are available
- What the patient's case state is
- Whether a handoff was triggered

The LLM reads context; Supabase/Postgres and validated tool results write business truth.

## 6. Supabase/Postgres and validated tool results are business truth

Availability slots, booking records, case states, contact records, and conversation states are all authoritative in the database. The runtime reads them before each turn and persists outcomes after each turn.

## 7. ClinicCard write actions are forbidden until booking.apply contract

The following actions are **forbidden** until the ClinicCard booking.apply contract is formally defined and approved:
- `createPatient`
- `createVisit`
- `booking.apply`
- `slot_hold`
- `handoff.create`
- `admin.notify` (except as a passive side-effect payload, never executed by the runtime)

## 8. "Booked" is forbidden without CRM/ClinicCard proof

The runtime must never say "booked", "confirmed", or "reserved" to a patient unless the booking backend has returned proof of the booking. Generating a reply that implies booking without backend confirmation is a correctness violation.

## 9. No debug/internal data in patient-facing transport replies

Transport adapters must send only `final_patient_reply` to the patient channel. Fields like `conversation_id`, `tool_results`, `debug`, `side_effects`, and `trace_id` are internal and must never appear in the message sent to the patient.

## 10. n8n is no longer the production patient-facing Telegram path

As of PR #109, native `POST /webhooks/telegram` is the production path for patient-facing Telegram. n8n no longer proxies patient messages. n8n may still be used for internal operational workflows (e.g., scheduling, CRM sync) but not for patient message routing.

## 11. doctor_id and cabinet_id come from trusted config, never from patient text

Slot checks and booking decisions use `doctor_id` and `cabinet_id` from validated configuration or RPC defaults. Values from patient messages must never be passed directly to booking RPCs.

## Enforcement

- The scope guard in `tests/runtimeRpcCapabilityMatrix.test.ts` enforces which files may be modified per PR.
- The ClinicCard write action guard in `tests/runtimeRpcCapabilityMatrix.test.ts` enforces forbidden terms.
- PRs touching transport adapters must include tests verifying: (a) the stateful pipeline is invoked, (b) dedupe works, (c) no patient-facing internal fields leak.
