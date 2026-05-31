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
- `topic_memory.last_service_interest` from typed Turn Understanding topic candidates only
- `turn_count_increment`

## Topic memory boundary

`topic_memory` persistence is limited to typed `topic_memory_candidate` updates where `topic_kind` is `service_interest`. Runtime must not infer or persist FAQ service topics from user text aliases, legacy router topics, regexes, or keyword lists. FAQ/non-operational turns without a typed topic source are skipped with `reason: "no_typed_topic_source"`.

## Failure behavior

Persistence is best-effort and non-fatal for live chat.

- Runtime turn still returns a normal response if persistence fails.
- `response.debug.persistence_debug` records per-step status.
- JSONL runtime turn logs include the same persistence debug envelope.


## Missing SQL in this repo

The repository does **not** currently include concrete SQL definitions for:

- `rpc_get_or_create_contact`
- `rpc_register_inbound_event`
- `rpc_save_message`
- `rpc_merge_conversation_state`

Given this gap, Runtime keeps non-fatal RPC calls in the repository layer, but this codebase must **not** add SQL stubs that can shadow/replace real DB functions.

Action required outside this repo: confirm real function signatures in the live core schema and keep runtime argument mapping aligned to those real RPC contracts.

Short rule: **do not add SQL stubs** for these RPCs here.
