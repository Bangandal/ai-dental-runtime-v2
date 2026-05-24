# Runtime DB Persistence

## Overview

Live `/runtime/turn` now persists a minimal durable trail into core DB RPCs.

- OpenAI `conversation_id` memory is only model continuity context.
- `core.messages`, `core.inbound_events`, and `core.convo_state` represent our durable runtime trail.
- Cases and booking persistence are intentionally deferred.

## Persisted flow per live turn

1. get/create contact
2. register inbound event
3. save user message
4. run runtime turn
5. save assistant message
6. merge minimal conversation state

## Conversation state merge shape

The route sends a minimal patch for:

- `last_user_message_text`
- `last_assistant_message_text`
- `last_intent` (if available)
- `last_bot_action` (if available)
- `last_bot_question` (when assistant reply contains a question)
- `conversation_id` / `openai_conversation_id`
- `turn_count_increment`

## Failure behavior

Persistence is best-effort and non-fatal for live chat.

- Runtime turn still returns a normal response if persistence fails.
- `response.debug.persistence_debug` records per-step status.
- JSONL runtime turn logs include the same persistence debug envelope.
