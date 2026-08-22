# Agent-first Runtime v1

## Goal

Move conversational ownership back to the model while preserving the existing deterministic Runtime as the authority for external truth and writes.

Target boundary:

- LLM owns understanding, dialogue, planning, clarification and recovery.
- Runtime owns persistence, tool execution, ClinicCard truth, identity safety, write guards, idempotency/concurrency and audit.

## Pilot scope

This first slice is intentionally narrow and reversible.

When `RUNTIME_AGENT_MODE=agent_first`:

1. deterministic tool/write guards still execute exactly as before;
2. a guarded batch no longer automatically disables all subsequent tools for the model;
3. the model may recover with another tool call or clarification until the hard per-turn model-call ceiling;
4. the default ceiling is 6 calls, configurable with `RUNTIME_AGENT_MAX_MODEL_CALLS` (2-12);
5. an appended system instruction explicitly assigns conversation/planning/recovery ownership to the model;
6. legacy mode remains the default and preserves the current 3-call behavior.

## Deliberately unchanged in v1

- ClinicCard executors and adapters;
- booking write authority;
- identity/subject guards;
- slot proof and `booking.select_slot` requirement;
- one-write-per-turn protection;
- persistence and conversation continuity;
- dedupe/serialization;
- reconciliation and audit behavior.

The next slice should only simplify model-facing booking ceremony after replay demonstrates that agent-first recovery is stable.

## Activation

```env
RUNTIME_AGENT_MODE=agent_first
RUNTIME_AGENT_MAX_MODEL_CALLS=6
```

Do not enable in production before replay/regression validation.
