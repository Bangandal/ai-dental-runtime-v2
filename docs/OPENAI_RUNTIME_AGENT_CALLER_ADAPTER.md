# OPENAI RuntimeAgentCaller Adapter

## Purpose

`src/runtime/openaiRuntimeAgentCaller.ts` implements the OpenAI adapter for the `RuntimeAgentCaller` abstraction.
It converts runtime loop input into an OpenAI Responses API request, then normalizes the response back into `RuntimeAgentCallerOutput`.

## Injected client boundary

The adapter requires an injected OpenAI-like client:

- `client.responses.create(input)`

This keeps transport/API client construction outside the adapter.
The adapter does **not** instantiate SDK clients and does **not** read environment variables.

## Normalization behavior

The adapter maps OpenAI response data into one of two runtime outputs:

1. `type: "tool_requests"`
   - includes normalized `tool`, `arguments`, and `call_id`
2. `type: "final_response"`
   - requires `final_patient_reply`

If OpenAI returns malformed output or missing `final_patient_reply`, the adapter returns a safe fallback final response:

- `final_patient_reply: "Sorry, I’m having trouble processing that right now. Please try again in a moment."`
- `safety_notes: ["malformed_openai_response"]`

## Active tools only

OpenAI tool definitions are built from active runtime tools only:

- `kb.search`
- `availability.check`

Future tools are intentionally excluded until activated.
`admin.notify` is never exposed.

## Boundary constraints

This module is adapter-only and intentionally excludes:

- HTTP/transport endpoints
- n8n/Telegram integrations
- MCP wiring
- booking/hold/cancel execution behavior

Runtime policy checks and tool execution ownership remain in backend runtime loop/executors.
