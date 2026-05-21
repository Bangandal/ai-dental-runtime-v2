# Runtime Tools vs Runtime Side Effects

## Runtime tools (policy + executors)
Runtime tools are executable actions that may be authorized by `applyToolPolicy(...)` and then dispatched to executors.

Examples:
- `kb.search` (read)
- `availability.check` (read-class but scheduling-sensitive)
- `hold.create` / `booking.confirm` / `cancel_hold`

## Runtime side effects (derived intents)
Runtime side effects are delivery intents derived from backend events, not planner-requested tools.

- `admin.notify` is side effect only (never a runtime `ToolName`).
- Side effects are derived by `deriveRuntimeSideEffects(...)`.
- `applyToolPolicy(...)` remains pure authorization and does not derive or execute side effects.

## Scheduling-sensitive read rule
`availability.check` is read-only in the matrix, but is confidence-gated:
- low confidence denies `availability.check` with `availability_check_requires_confidence`.
- rationale: availability checks can drive slot offers and downstream booking flow.
