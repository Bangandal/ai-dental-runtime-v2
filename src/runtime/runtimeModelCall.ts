import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
} from "./openaiRuntimeAgent.ts";

export interface RuntimeAgentCallerInput {
  model: string;
  conversation_id?: string | null;
  system_instruction: string;
  input: {
    message: string;
    context: Record<string, unknown>;
    tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
    tool_results?: RuntimeAgentToolResult[];
  };
}

export type RuntimeAgentCallerOutput =
  | {
      type: "tool_requests";
      conversation_id?: string | null;
      tool_requests: RuntimeAgentToolRequest[];
      usage?: unknown;
    }
  | {
      type: "final_response";
      conversation_id?: string | null;
      final_response: RuntimeAgentFinalResponse;
      usage?: unknown;
    };

export type RuntimeAgentCaller = (input: RuntimeAgentCallerInput) => Promise<RuntimeAgentCallerOutput>;

export type RuntimeModelCallOutcome =
  | {
      ok: true;
      output: RuntimeAgentCallerOutput;
      conversation_id: string | null;
    }
  | {
      ok: false;
      error: unknown;
      conversation_id: string | null;
    };

/**
 * Transport-only boundary for one runtime model call.
 *
 * This function deliberately owns no business fallback, booking guard, dirty-memory,
 * or model-output policy. It only constructs the caller payload, invokes the caller,
 * and resolves the next conversation id. The orchestrator decides what an exception,
 * malformed output, or further tool request means.
 */
export async function invokeRuntimeModelCall(params: {
  caller: RuntimeAgentCaller;
  model: string;
  conversation_id: string | null;
  system_instruction: string;
  message: string;
  context: Record<string, unknown>;
  tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
  tool_results?: RuntimeAgentToolResult[];
}): Promise<RuntimeModelCallOutcome> {
  const {
    caller,
    model,
    conversation_id,
    system_instruction,
    message,
    context,
    tool_definitions,
    tool_results,
  } = params;

  try {
    const output = await caller({
      model,
      conversation_id,
      system_instruction,
      input: {
        message,
        context,
        ...(tool_definitions !== undefined ? { tool_definitions } : {}),
        ...(tool_results !== undefined ? { tool_results } : {}),
      },
    });

    return {
      ok: true,
      output,
      conversation_id: output.conversation_id !== undefined
        ? output.conversation_id
        : conversation_id,
    };
  } catch (error) {
    return {
      ok: false,
      error,
      conversation_id,
    };
  }
}
