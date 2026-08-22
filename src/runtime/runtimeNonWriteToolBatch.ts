import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
  type RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import { executeRuntimeToolRequest } from "./runtimeToolRequestExecution.ts";

const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);

export interface ExecuteRuntimeNonWriteToolBatchParams {
  requests: RuntimeAgentToolRequest[];
  input: RuntimeAgentTurnInput;
  executors: ToolExecutorRegistry;
  now?: Date;
}

export interface ExecuteRuntimeNonWriteToolBatchResult {
  tool_results: RuntimeAgentToolResult[];
  availability_diagnostic?: unknown;
}

/**
 * Execute the phase-independent, non-write portion of a model tool batch.
 *
 * booking.select_slot is owned by the slot-selection batch kernel because it mutates
 * slot proof state. booking.apply is owned by the booking write/preflight kernel.
 * Everything else is either executed through the canonical runtime tool pipeline or
 * closed with a deterministic inactive-tool denial so no model call id is left open.
 */
export async function executeRuntimeNonWriteToolBatch(
  params: ExecuteRuntimeNonWriteToolBatchParams,
): Promise<ExecuteRuntimeNonWriteToolBatchResult> {
  const toolResults: RuntimeAgentToolResult[] = [];
  let availabilityDiagnostic: unknown = undefined;

  for (const request of params.requests) {
    if (request.tool === "booking.select_slot" || request.tool === "booking.apply") {
      continue;
    }

    if (!ACTIVE_TOOL_SET.has(request.tool)) {
      toolResults.push({
        tool: request.tool,
        call_id: request.call_id,
        status: "denied",
        error: {
          code: "tool_not_active",
          message: `${request.tool} is not active`,
        },
      });
      continue;
    }

    const execution = await executeRuntimeToolRequest({
      input: params.input,
      request,
      executors: params.executors,
      now: params.now,
      execution_subject_id: null,
    });
    toolResults.push(execution.tool_result);
    if (execution.availability_diagnostic !== undefined) {
      availabilityDiagnostic = execution.availability_diagnostic;
    }
  }

  return {
    tool_results: toolResults,
    ...(availabilityDiagnostic !== undefined
      ? { availability_diagnostic: availabilityDiagnostic }
      : {}),
  };
}
