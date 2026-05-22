# OpenAI Conversation Memory Persistence

## Purpose
OpenAI `conversation_id` persistence exists to preserve dialogue continuity across runtime turns.

## Memory Mode (Contract)
- Runtime uses **OpenAI conversation object mode**.
- `conversation_id` means the OpenAI **conversation object id**.
- `conversation_id` is passed to OpenAI as `conversation`.
- `conversation_id` is **not** `previous_response_id`.
- Runtime persists only the conversation id metadata, not full dialogue transcripts.

## Boundary and Source of Truth
- OpenAI conversation memory stores dialogue continuity items only.
- Supabase/Postgres remains the source of truth for business state.
- OpenAI memory must not be treated as proof of bookings, appointments, holds, prices, patient identity, or case state.
- Deterministic tool outputs and DB/RPC-validated data remain business truth.

## Scope Strategy
Preferred scope for persisted OpenAI conversation ids:
1. **Per case** when `case_id` exists (one OpenAI conversation per case).
2. **Per contact fallback** only before case resolution/availability.

When a new case starts, runtime should use either:
- `null` `conversation_id`, or
- a new OpenAI conversation id returned by OpenAI.

## Runtime Turn Assembly Flow
1. Runtime resolves `conversation_id` before calling the OpenAI runtime caller.
2. Resolution priority:
   1. Explicit `input.conversation_id`
   2. Repository memory (`ConversationMemoryRepository.getConversationMemory`) scoped by `case_id` when available
   3. `null`
3. Runtime passes resolved `conversation_id` into the caller request.
4. Runtime stores returned `conversation_id` through `ConversationMemoryRepository.saveConversationMemory` when available.
5. Runtime metadata may expose:
   - `resolved_conversation_id`
   - `returned_conversation_id`
   - `conversation_id` (compatibility field containing final value)

## Failure Handling
- Conversation memory repository load failures are non-fatal.
- Conversation memory repository save failures are non-fatal.
- These failures should be captured in runtime debug metadata/warnings and never invalidate already-completed deterministic tool execution.

## Storage Placement
`conversation_id` may be persisted against case, contact, or a dedicated conversation-state record depending on existing database shape. This document defines contract intent, not SQL or migration requirements.

## Absence of conversation_id
Missing `conversation_id` is valid. OpenAI may create a new conversation/session and return a conversation id in the response. Runtime should persist that returned id when repository support is configured.
