# OpenAI conversation memory wiring for live `/runtime/turn`

## Purpose

`conversation_id` in Runtime V2 is **model continuity only**. It helps the OpenAI model continue the same conversational thread, but it is **not business truth**.

## What is persisted

We persist only a key-to-`conversation_id` mapping in `core.openai_conversation_memory`:

- `clinic_id`
- `channel`
- `external_user_id` or `chat_id`
- `conversation_id`
- timestamps

No raw message history is stored in this table.

## Live route behavior

For `/runtime/turn`:

1. Before `runTurn`, runtime loads memory by key:
   - `clinic_id + channel + external_user_id` when external user id is available.
   - otherwise `clinic_id + channel + chat_id`.
2. If memory exists, route passes `conversation_id` to runtime service.
3. If memory does not exist, route creates a new OpenAI conversation object and passes that `conversation_id` to runtime service.
4. After `runTurn`, route upserts memory using:
   - `result.conversation_id` when present, otherwise
   - the pre-created `conversation_id` used for the turn.

Load/save failures and conversation creation failures are non-fatal and should not break runtime replies.

## Boundary reminders

- Database mapping stores identifiers only, not conversation contents.
- Business truth remains in Supabase core state/cases/messages and domain RPC data.
- OpenAI memory must not be treated as source of truth for bookings, holds, appointments, pricing, or identity.
