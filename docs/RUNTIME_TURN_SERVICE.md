# Runtime Turn Service

## Purpose
`RuntimeTurnService` is the internal service boundary for one runtime turn.

It provides a single entrypoint (`runTurn`) that future transport/HTTP layers can call without depending directly on runtime agent construction details.

## Position in the Architecture
- Transport (future HTTP/other adapters) will call `RuntimeTurnService`.
- `RuntimeTurnService` sits above `OpenAIRuntimeAgent`.
- `RuntimeTurnService` delegates to the runtime agent and returns normalized runtime output.

## Scope and Non-Scope
This module intentionally:
- does not add an HTTP endpoint,
- does not integrate n8n or Telegram,
- does not call OpenAI SDK directly,
- does not call RPC directly,
- does not perform booking writes.

It is intentionally thin and focused on service boundary shape.

## Contract
### Input
`RuntimeTurnInput` carries conversation context and turn payload (clinic/contact/case IDs, conversation ID, user message, locale, optional business context/truth snapshot, optional recent summary).

### Output
`RuntimeTurnResult` always returns:
- `final_patient_reply` (required),
- optional `conversation_id`,
- `tool_requests`,
- `tool_results`,
- optional `debug`.

If `final_patient_reply` is missing/blank, the service throws a contract error.

## Ownership Boundaries
- AI still owns dialogue, reasoning, tool selection, and the final patient reply.
- Backend/runtime tool execution still owns policy checks, deterministic validation, and tool execution.
- Business truth remains in validated tools and database-backed systems (not in dialogue memory).
