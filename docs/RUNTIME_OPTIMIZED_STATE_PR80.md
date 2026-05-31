# Runtime Optimized State Verification (PR80)

## Goal
Document the verified optimized runtime state after disabling the deprecated `legacy_case_router` by default and adding runtime LLM call debug counters.

## Verified defaults
When `LEGACY_CASE_ROUTER_ENABLED` is unset or any value other than the exact string `"true"`:

- `legacy_case_router` remains disabled and shadow-only.
- The legacy case router classifier is not invoked.
- `debug.legacy_case_router` is still emitted with `enabled: false`, `skipped: true`, and `skip_reason: "legacy_case_router_disabled"`.
- `debug.llm_calls.legacy_case_router_called` remains `false` and does not contribute to `total_llm_calls`.

## LLM-backed runtime component accounting
`debug.llm_calls` reflects only components that were actually invoked for the turn:

- `runtime_gate_called` is `true` only when a runtime gate classifier dependency is configured.
- `turn_understanding_called` is `true` only when the runtime gate returns `operational_candidate` and a turn understanding classifier dependency is configured.
- `legacy_case_router_called` is `true` only when `LEGACY_CASE_ROUTER_ENABLED === "true"` and a legacy case router classifier dependency is configured.
- `main_agent_called` is supplied by the runtime agent debug envelope and remains unchanged by the shadow classifiers.
- `total_llm_calls` is the sum of the above invoked component flags.

## Runtime behavior invariants
These checks are observability-only. PR80 does not implement unified classifier behavior, booking, case apply, Topic Memory behavior changes, DB/schema changes, prompt changes, or new default LLM calls. Patient-facing replies continue to come from the main runtime turn service.
