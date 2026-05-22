# Runtime Turn HTTP Endpoint (`POST /runtime/turn`)

## Purpose

This endpoint is the backend controller boundary for transport adapters (currently n8n + Telegram) to submit a patient message into the runtime.

It accepts transport-normalized input, maps it into `RuntimeTurnInput`, and delegates processing to `RuntimeTurnService`.

The route intentionally contains no booking logic, no direct tool execution, and no transport workflow logic.

## n8n Payload Compatibility

Expected request body:

```json
{
  "clinic_code": "string",
  "channel": "telegram",
  "external_user_id": "string",
  "chat_id": "string",
  "text": "string",
  "meta": {}
}
```

Validation rules:

- `clinic_code` required
- `channel` required
- `text` required
- at least one of `external_user_id` or `chat_id` required

Invalid payload returns `400` with:

```json
{
  "error": {
    "code": "invalid_runtime_turn_request",
    "message": "..."
  }
}
```

## Runtime Input Mapping (MVP placeholder)

The endpoint currently performs explicit MVP mapping:

- `clinic_id = clinic_code`
- `contact_id = ${channel}:${external_user_id || chat_id}`
- `case_id = null`

This is a narrow placeholder boundary and not a full case/contact resolver.

`conversation_id` is not required from n8n.

## Response Compatibility

Response shape:

```json
{
  "trace_id": "string",
  "reply_text": "string",
  "final_patient_reply": "string",
  "conversation_id": "string | null",
  "tool_results": [],
  "side_effects": [],
  "debug": {}
}
```

Notes:

- n8n should use `reply_text` for the user-visible outbound message.
- `final_patient_reply` is duplicated for clarity/debugging.
- `conversation_id` is debug visibility only; backend owns memory.
- `side_effects` remains transport-consumable and defaults to empty for success.

## Runtime Failure Behavior

If `RuntimeTurnService` throws, endpoint returns `200` with a safe fallback reply and `admin_notification` side effect so transport can still respond to patient:

- `reply_text`/`final_patient_reply` contain a safe Russian fallback.
- `side_effects` includes `runtime_turn_failed` admin notification payload.
- `debug.runtime_error` contains error details for observability.


## Server Wiring (PR37)

Server bootstrap should register the endpoint through:

- `registerRuntimeRoutes(app, { openaiClient, model, rpc })` from `src/runtime/runtimeServerBootstrap.ts`
- internally: `registerRuntimeTurnRoute(app, { runtimeTurnService: createDentalRuntimeTurnService(...) })`

This keeps `POST /runtime/turn` unchanged while switching endpoint execution to `RuntimeTurnService` and the runtime agent loop stack.

## Bootstrap Audit Notes

Within this repository scope, no legacy `/runtime/turn` bootstrap or old runtime route registration module exists anymore. The canonical route wiring path is now `runtimeServerBootstrap -> runtimeTurnHttpRoute -> RuntimeTurnService`.

## Ownership Boundaries

- Transport/n8n owns delivery and side-effect dispatch.
- Backend endpoint owns validation and runtime delegation.
- Backend runtime owns memory/tool/policy/truth execution.
- No booking writes are performed in this endpoint.
