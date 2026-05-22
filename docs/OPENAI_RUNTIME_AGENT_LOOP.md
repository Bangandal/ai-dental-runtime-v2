# OpenAI Runtime Agent Loop (PR30)

This module implements one internal runtime agent turn with one optional tool round.

## Ownership model

- AI owns final_patient_reply, dialogue, reasoning, and tool selection.
- Backend owns tool execution, permissions/policy, deterministic validation, and execution boundaries.
- DB/Supabase and validated tool results own business truth.
- Conversation memory stores continuity only and is not business truth.

## Flow

1. Runtime loads conversation memory (if no explicit conversation_id and repository is provided).
2. Runtime calls injected runtime agent caller with:
   - user message
   - context
   - active runtime tool definitions
3. If AI returns final_response immediately, runtime returns it.
4. If AI returns tool_requests:
   - runtime intercepts requests
   - inactive/future/unknown tools are denied
   - active requests are adapted into minimal policy inputs
   - ToolPolicy decides allowed/denied
   - executors run only for allowed tools
   - runtime converts ToolExecutionResult to RuntimeAgentToolResult
5. Runtime calls AI a second time with tool_results.
6. AI final_patient_reply is returned to caller.

## Boundaries and constraints

- Active tools only: `kb.search`, `availability.check`.
- Future tools remain inactive: `hold.create`, `booking.confirm`, `cancel_hold`, `appointment.lookup`.
- No MCP.
- No transport wiring (no HTTP endpoint in PR30).
- No n8n/Telegram integration.
- No booking writes implemented here.
- No direct OpenAI SDK, Supabase, calendar, or Telegram imports.

## Error behavior

- First caller failure returns safe fallback reply and no tool execution.
- Second caller failure returns safe fallback reply and preserves tool_results.
- If second call requests tools again, multi-round loop is not implemented in PR30 and safe fallback is returned.

