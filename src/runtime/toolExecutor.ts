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
  clinic_id?: string;
  requested_date?: string;
  requested_time?: string | null;
  service_interest?: string | null;
  query_text?: string;
  locale?: string | null;
  timezone?: string;
  limit?: number;
  now?: Date;
  planner?: PlannerOutput;
  truth_snapshot?: TruthSnapshot;
  /** Patient first name — extracted from booking.apply tool arguments. */
  first_name?: string;
  /** Patient last name — extracted from booking.apply tool arguments. */
  last_name?: string;
  /** Phone number captured from the channel contact mechanism (e.g. contact button) or patient-typed text. */
  phone_number?: string;
  /** Source of the captured phone number. */
  phone_source?: string;
  /** Trust level of the phone — "unverified" for patient-typed numbers, absent/undefined for trusted sources. */
  phone_trust?: "unverified";
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
