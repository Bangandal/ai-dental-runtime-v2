import type { PlannerOutput, PolicyResult, ToolName, TruthSnapshot } from "./toolPolicy.ts";
import {
  makeFailedToolResult,
  makeNotImplementedToolResult,
  type ToolExecutionPlan,
  type ToolExecutionResult,
} from "./toolResults.ts";

export interface ToolExecutionContext {
  trace_id?: string;
  contact_id?: string;
  case_id?: string;
  timezone?: string;
  now?: Date;
  planner?: PlannerOutput;
  truth_snapshot?: TruthSnapshot;
}

export type ToolExecutor = (
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export type ToolExecutorRegistry = Partial<Record<ToolName, ToolExecutor>>;

export interface ExecuteAllowedToolsInput {
  tools_allowed: ToolName[];
  registry?: ToolExecutorRegistry;
  context: ToolExecutionContext;
}

export async function executeAllowedTools(
  input: ExecuteAllowedToolsInput,
): Promise<ToolExecutionResult[]> {
  const registry = input.registry ?? {};
  const results: ToolExecutionResult[] = [];

  for (const tool of input.tools_allowed) {
    const executor = registry[tool];
    if (!executor) {
      results.push(makeNotImplementedToolResult(tool));
      continue;
    }

    try {
      const result = await executor(input.context);
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        makeFailedToolResult(
          tool,
          "executor_exception",
          message,
          true,
        ),
      );
    }
  }

  return results;
}

export function buildToolExecutionPlan(
  policyResult: PolicyResult,
): ToolExecutionPlan {
  return {
    tools_allowed: policyResult.tools_allowed,
    policy_denials: policyResult.tools_denied,
  };
}
