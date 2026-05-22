# OpenAI Runtime Agent Contract (PR29)

## Why planner-only was removed

PR28 removed the planner-only top layer to prevent architectural drift where planning artifacts become de facto runtime truth. The runtime now centers on a direct agent contract where AI reasoning can request tools, but backend systems remain the source of deterministic execution and enforcement.

## Runtime agent ownership

The runtime agent owns:
- Dialogue behavior and conversational tone.
- Reasoning about user intent.
- Tool selection requests.
- The final patient reply (`final_patient_reply`).

The runtime agent does **not** own execution, permissions, or persistence.

## Backend ownership

Backend owns:
- Policy and permission checks before any tool execution.
- Deterministic validation and business-rule enforcement.
- Tool execution orchestration.
- Database/RPC access and trusted state handling.

This keeps AI capability expressive while preserving deterministic safety boundaries.

## Tool loop concept

The contract models a tool loop without implementing the loop itself yet:
1. Agent receives `RuntimeAgentTurnInput`.
2. Agent may emit `tool_requests`.
3. Backend policy-gates and executes tools.
4. Backend returns `tool_results` as truth-bearing evidence.
5. Agent returns a required `final_patient_reply`.

## Policy/executor boundary

- Agent can request tools, but must never execute tools directly.
- Backend must policy-check tool requests before executor runs.
- Agent must not claim bookings, availability, or clinic facts without supporting tool/runtime truth.

## Memory boundary

Conversation memory is for continuity only (tone, context carryover, user preferences in dialogue). It is not business truth.

Business truth is derived from:
- Supabase/Postgres state.
- Validated runtime context.
- Tool results produced under backend policy and execution controls.

## Active vs future tools

Active tool definitions in this contract are intentionally limited to:
- `kb.search`
- `availability.check`

Future tools are enumerated separately but are not active in current tool definitions:
- `hold.create`
- `booking.confirm`
- `cancel_hold`
- `appointment.lookup`

`admin.notify` is intentionally excluded from agent tool definitions.

## No MCP yet

This contract does not add MCP, OpenAI SDK calls, transport wiring, n8n, Telegram, or HTTP integration. It only establishes type and instruction boundaries for the upcoming runtime tool loop implementation.
