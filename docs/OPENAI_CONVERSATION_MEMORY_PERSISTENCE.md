# OpenAI Conversation Memory Persistence

## Purpose
OpenAI `conversation_id` persistence exists to preserve dialogue continuity across runtime turns.

## Boundary and Source of Truth
- `conversation_id` is memory metadata for conversation continuity only.
- Supabase/Postgres remains the source of truth for business state.
- OpenAI memory must not be treated as proof of bookings, appointments, holds, prices, patient identity, or case state.

## Runtime Turn Assembly Flow
1. Runtime Turn Assembly resolves `conversation_id` before `OpenAIPlanner.plan`.
2. Resolution priority:
   1. Explicit `input.conversation_id`
   2. Repository memory (`ConversationMemoryRepository.getConversationMemory`) scoped by `case_id` when available
   3. `null`
3. Runtime passes resolved `conversation_id` into planner input.
4. after planner execution, runtime saves returned `conversation_id` through `ConversationMemoryRepository.saveConversationMemory`.
5. Assembly result metadata exposes:
   - `resolved_conversation_id`
   - `returned_conversation_id`
   - `conversation_id` (compatibility field containing final value)

## Failure Handling
- Conversation memory repository load failures are non-fatal.
- Conversation memory repository save failures are non-fatal.
- These failures should be captured in runtime debug metadata/warnings and never invalidate already-completed deterministic tool execution.

## Storage Placement
`conversation_id` may be persisted against case, contact, or a dedicated conversation-state record depending on existing database shape. This document defines contract intent, not SQL or migration requirements.
