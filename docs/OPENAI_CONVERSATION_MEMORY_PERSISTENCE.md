# OpenAI Conversation Memory Persistence

## Purpose
OpenAI `conversation_id` persistence exists to preserve dialogue continuity across runtime turns.

## Boundary and Source of Truth
- `conversation_id` is memory metadata for conversation continuity only.
- Supabase/Postgres remains the source of truth for business state.
- OpenAI memory must not be treated as truth for bookings, holds, appointments, prices, insurance, patient identity, or case state.

## Runtime Flow Contract
1. Runtime should load `conversation_id` from the repository boundary before `OpenAIPlanner.plan`.
2. Runtime should save returned `conversation_id` through the repository boundary after planner execution.
3. Missing `conversation_id` is acceptable and indicates planner execution can proceed without prior conversation memory.

## Storage Placement
`conversation_id` may be persisted against case, contact, or a dedicated conversation-state record depending on existing database shape. This document defines contract intent, not SQL or migration requirements.
