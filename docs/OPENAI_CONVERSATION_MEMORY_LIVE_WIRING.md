# Provider conversation memory wiring for live `/runtime/turn`

## Purpose

Runtime V2 separates **dialogue memory** from **provider transport continuity**.

- Durable cross-turn dialogue continuity belongs to Runtime/Supabase messages and structured state.
- A provider conversation/thread id is transport state only. It is never business truth.

This distinction is mode-specific so legacy rollback stays intact while `agent_first` remains portable to other model providers.

## Legacy mode

Legacy keeps the historical OpenAI conversation-object behavior unchanged.

For `/runtime/turn`:

1. Before `runTurn`, Runtime loads the stored provider conversation mapping by:
   - `clinic_id + channel + external_user_id` when external user id is available;
   - otherwise `clinic_id + channel + chat_id`.
2. If memory exists, the stored `conversation_id` is passed to the runtime service.
3. If memory does not exist, the route may create a new OpenAI conversation object.
4. After `runTurn`, the route persists the resumable `conversation_id` mapping.

The mapping lives in `core.openai_conversation_memory` and stores identifiers only, not raw message history.

## Agent-first mode

`agent_first` does **not** use provider conversation ids as cross-turn memory.

For every new patient message:

1. Runtime starts with no previously stored provider conversation id.
2. Runtime/Supabase `recent_history` and durable structured state provide cross-turn dialogue continuity.
3. The OpenAI adapter may create a fresh conversation object for this patient turn.
4. That fresh id may be reused only inside the same `model -> tool -> model` iteration so function-call continuity remains valid.
5. The provider conversation id is not loaded from or persisted to `core.openai_conversation_memory` for the next patient turn.

This makes the conversational memory contract provider-neutral: another model adapter can implement its own turn-local tool-call continuity without becoming a second durable memory system.

## Boundary reminders

- Runtime/Supabase messages and structured state are the single cross-turn memory source in `agent_first`.
- Provider thread ids are transport details, not dialogue truth or business truth.
- Business truth remains in Supabase core state/cases/messages and domain RPC/tool data.
- Booking, holds, appointments, pricing, identity, staff-delivery proof and other actions must never be inferred from provider memory.
- The legacy provider-memory table/RPC remains available for rollback and is intentionally not removed by the agent-first boundary.
