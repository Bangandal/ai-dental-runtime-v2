# Runtime Live JSONL Logging

Runtime V2 now persists live `/runtime/turn` traffic as append-only JSONL files.

## Files
- `runtime-turns.jsonl`: successful turn events (`status: "ok"`).
- `runtime-errors.jsonl`: validation/runtime error events (`status: "validation_error" | "runtime_error"`).

## Environment
- `RUNTIME_LOG_DIR` controls log directory (default: `./logs` in production startup).

## Tailing logs
```bash
tail -f /opt/runtime-v2/logs/runtime-turns.jsonl
tail -f /opt/runtime-v2/logs/runtime-errors.jsonl
```

## Secret safety
Logging intentionally excludes secrets and sensitive transport internals, including:
- API keys (OpenAI/Supabase)
- full `process.env`
- authorization headers
- credentials payloads

## Debug envelope vs persistent JSONL
- Debug envelope is response-level artifact returned per request.
- JSONL logging is persistent black-box request recording for live operations and post-mortem analysis.
