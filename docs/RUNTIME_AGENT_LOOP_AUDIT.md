# Runtime Agent Loop Audit (PR27)

## Goal
## PR28 Update
Planner-only top-layer files (`openaiPlanner`, `runtimeTurnAssembly`) were removed in **PR28** as cleanup to prevent architectural conflict with the target runtime-agent loop. The new OpenAI Runtime Agent Tool Loop orchestration will be introduced in the next implementation PR.

Audit the current planner-only top layer and define the target **OpenAI Runtime Agent Tool Loop** without replacing the runtime loop in this PR.

## Current Runtime (Planner-Only) Flow

```text
Patient message
  -> OpenAIPlanner.plan()
  -> parsePlannerOutput()
  -> buildTruthSnapshot()
  -> applyToolPolicy()
  -> buildToolExecutionPlan()
  -> executeAllowedTools()
  -> return { tool_results, debug_envelope, policy outputs }
```

### Observed planner-only assumptions
1. **Model is constrained to JSON planner output**, not final conversational output.
2. **Single model call per turn** in assembly (`planner.plan()`), with no continuation call after tool results.
3. Runtime assembles policy/execution artifacts and returns them, but does **not produce AI-authored final patient response**.
4. Top-level result contract is optimized for planner diagnostics (`parsed_planner`, `execution_plan`, `tool_results`, `debug_envelope`).
5. System instruction in `openaiPlanner` explicitly frames the model as a planner and disallows direct conversational completion path.

## What Remains Valid (Preserve)
The following layers are correct and should be reused in the runtime-agent rewrite:

- **ToolPolicy** (`applyToolPolicy`)  
  Preserves deterministic business gating, denied/invalid tool handling, and confidence/confirmation safeguards.
- **Executors + executor registry** (`executeAllowedTools`, KB and availability executors)  
  Keeps backend-controlled tool execution and deterministic boundaries for side effects.
- **Repositories** (`runtimeRepositories`, Supabase repositories)  
  Keeps DB/RPC boundaries in backend components, not in model logic.
- **ConversationMemoryRepository**  
  Keeps conversation continuity via `conversation_id` load/save with non-fatal error handling.
- **TruthSnapshot**  
  Keeps deterministic state interpretation and scheduling signals grounded in backend context.
- **Debug envelope + safe guards**  
  Keeps observability, parse/policy/tool traces, and runtime error reporting (`planner_execution_failed`).
- **Denied/invalid tool protections**  
  Continue to block forbidden tools and prevent unauthorized writes.

These components already align with the intended architecture split: AI reasoning + backend truth enforcement.

## What Becomes Legacy / Transitional
- `OpenAIPlanner` naming and planner-only role become **transitional**.
- `runRuntimeTurnAssembly` current top-layer sequence is **legacy planner flow** because it ends at tool execution artifacts.
- JSON-only planner prompt contract is **legacy** for final runtime shape.
- `RuntimeTurnAssemblyResult` lacking `final_patient_reply` is a legacy contract for intermediate state only.

## Why Runtime Diverged From Product Intent
The runtime was optimized for safe deterministic planning and tool gating first, which produced a robust backend control plane. However, this moved the top layer into a planner pipeline that terminates after tool execution, instead of completing a full conversational loop where AI authors the patient-facing response using tool outputs.

## Target Architecture (OpenAI Runtime Agent Tool Loop)

```text
Patient message
  -> OpenAI Runtime Agent (turn start with memory + business context + allowed tools)
  -> Agent requests tool
  -> Backend policy validates tool request
  -> Backend executor executes allowed tool
  -> Tool result returned to agent
  -> Agent continues reasoning (may request additional tools)
  -> Agent emits final_patient_reply
  -> Runtime returns final reply to patient
```

## Ownership Model (Target)
- **AI owns**: dialogue, reasoning, tool selection, final patient reply.
- **Backend owns**: permissioning/policy, deterministic validation, tool execution, DB/RPC boundaries, business side-effect control.
- **Supabase/Postgres owns**: appointment/hold/patient/case/availability truth.
- **Conversation memory owns**: dialogue continuity only (never business truth).

## Migration Strategy (Next PRs)

### Reuse as-is or near-as-is
- `toolPolicy.ts`
- `toolExecutor.ts`
- `kbSearchExecutor.ts`, `availabilityCheckExecutor.ts`
- `truthSnapshot.ts`
- `runtimeRepositories.ts`
- `debugEnvelope.ts`

### Rewrite / replace top-layer orchestration
- Replace planner-only single-call orchestration with runtime-agent continuation loop.
- Add runtime contract containing `final_patient_reply` as required output.
- Shift parser assumptions from strict planner JSON pipeline to agent/tool-call protocol handling.

### Rename / deprecate candidates
- `OpenAIPlanner` -> transitional alias or replacement (`OpenAIRuntimeAgent` boundary).
- `runtimeTurnAssembly` -> transitional adapter around legacy planner flow.
- Planner-only parse/result DTOs -> eventually deprecated when runtime-agent loop is primary.

### Later deletion candidates (post-migration)
- Planner-only prompt scaffolding and strict JSON planner contract once agent loop is stable and fully covered by tests.

## Scope Notes for PR27
- This PR is audit/specification/planning only.
- No full runtime-agent loop implementation.
- Existing safety and policy protections remain active.
