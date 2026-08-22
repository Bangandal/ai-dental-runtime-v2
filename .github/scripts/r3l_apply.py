from pathlib import Path
import re

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

# Imports: loop should only keep executor registry type and delegate policy-backed execution.
source, count = re.subn(
    r'import \{ applyToolPolicy, type PlannerOutput, type ToolName, type TruthSnapshot \} from "\.\/toolPolicy\.ts";\n'
    r'import \{ executeAllowedTools, type ToolExecutorRegistry, type ToolExecutionContext \} from "\.\/toolExecutor\.ts";\n'
    r'import \{ buildTruthSnapshot \} from "\.\/truthSnapshot\.ts";\n'
    r'import type \{ ConversationMemoryRepository \} from "\.\/runtimeRepositories\.ts";\n'
    r'import type \{ ToolExecutionResult \} from "\.\/toolResults\.ts";',
    'import type { ToolExecutorRegistry } from "./toolExecutor.ts";\n'
    'import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";',
    source,
)
assert count == 1, f"execution import replacement count={count}"

source, count = re.subn(
    r'import \{ hasTrustedPhone, hasBookingContactPhone, hasBookingApplyPending \} from "\.\/bookingContactGuard\.ts";',
    'import { hasTrustedPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";',
    source,
)
assert count == 1, f"booking contact import replacement count={count}"

anchor = 'import { buildPhoneCaptureUi, sanitizePhoneCaptureUiForChannel } from "./channelCapabilityPolicy.ts";\n'
replacement = anchor + 'import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n' + 'export { buildSubjectAwarePhoneFields, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n'
assert anchor in source
source = source.replace(anchor, replacement, 1)

round1_old = r'''          const planner = buildPlannerFromAgentToolRequest\(request\);\n          const truth = resolveTruthSnapshot\(input, request, planner, turnNow\);\n          const policy = applyToolPolicy\(planner, truth\);\n          if \(policy\.tools_denied\.length > 0 \|\| policy\.tools_allowed\.length === 0\) \{.*?          toolResults\.push\(convertToolExecutionResult\(request, execResult\)\);'''
round1_new = '''          const execution = await executeRuntimeToolRequest({
            input: request.tool === "booking.apply" ? effectiveInput : input,
            request,
            executors: deps.executors,
            now: turnNow,
            execution_subject_id: request.tool === "booking.apply" ? round1ExecutionSubjectId : null,
          });
          if (execution.availability_diagnostic !== undefined) {
            debug.availability_diagnostic = execution.availability_diagnostic;
          }
          toolResults.push(execution.tool_result);'''
source, count = re.subn(round1_old, round1_new, source, count=1, flags=re.S)
assert count == 1, f"round1 execution replacement count={count}"

round2_old = r'''          const bPlanner = buildPlannerFromAgentToolRequest\(pendingBookingApply\);\n          const bTruth = resolveTruthSnapshot\(effectiveInput, pendingBookingApply, bPlanner, turnNow\);\n          const bPolicy = applyToolPolicy\(bPlanner, bTruth\);\n\n          let bookingToolResult: RuntimeAgentToolResult;\n          if \(bPolicy\.tools_denied\.length > 0 \|\| bPolicy\.tools_allowed\.length === 0\) \{.*?          \}\n\n          const allResults = \[\.\.\.toolResults, bookingToolResult\];'''
round2_new = '''          const bookingExecution = await executeRuntimeToolRequest({
            input: effectiveInput,
            request: pendingBookingApply,
            executors: deps.executors,
            now: turnNow,
            execution_subject_id: round2ExecutionSubjectId,
          });
          const bookingToolResult = bookingExecution.tool_result;

          const allResults = [...toolResults, bookingToolResult];'''
source, count = re.subn(round2_old, round2_new, source, count=1, flags=re.S)
assert count == 1, f"round2 execution replacement count={count}"

# Remove the helper cluster that now belongs to runtimeToolRequestExecution.
source, count = re.subn(
    r'function buildPlannerFromAgentToolRequest\(request: RuntimeAgentToolRequest\): PlannerOutput \{.*?(?=/\*\* Marks debug so callers/logs can see)',
    '',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"helper cluster removal count={count}"

for forbidden in [
    'applyToolPolicy(', 'executeAllowedTools(', 'buildTruthSnapshot(',
    'buildPlannerFromAgentToolRequest(', 'resolveTruthSnapshot(', 'buildExecutionContext(',
    'convertToolExecutionResult(', 'hasBookingContactPhone(',
]:
    if forbidden in source:
        raise AssertionError(f"legacy loop still owns {forbidden}")

path.write_text(source)
