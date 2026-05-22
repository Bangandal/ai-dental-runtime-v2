import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
} from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeAgentLoop.ts";

export interface OpenAIResponsesClient {
  responses: {
    create(input: unknown): Promise<unknown>;
  };
}

export interface CreateOpenAIRuntimeAgentCallerDeps {
  client: OpenAIResponsesClient;
}

const SAFE_FALLBACK_REPLY = "Sorry, I’m having trouble processing that right now. Please try again in a moment.";

export function createOpenAIRuntimeAgentCaller(deps: CreateOpenAIRuntimeAgentCallerDeps): RuntimeAgentCaller {
  return async (input) => {
    const openAIInput = buildOpenAIInput(input);
    const rawResponse = await deps.client.responses.create(openAIInput);
    return normalizeOpenAIResponse(rawResponse, input.conversation_id ?? null);
  };
}

export function buildOpenAIToolDefinitions(input: RuntimeAgentCallerInput): Array<Record<string, unknown>> {
  return ACTIVE_RUNTIME_AGENT_TOOLS.map((toolName) => {
    const def = input.input.tool_definitions[toolName];
    return {
      type: "function",
      name: toolName,
      description: def.description,
      parameters: {
        type: "object",
        properties: buildParameterProperties(def.required_args, def.optional_args),
        required: [...def.required_args],
        additionalProperties: true,
      },
    };
  });
}

export function buildOpenAIInput(input: RuntimeAgentCallerInput): Record<string, unknown> {
  const toolResults = input.input.tool_results;
  const userPayload = {
    message: input.input.message,
    context: input.input.context,
  };

  return {
    model: input.model,
    instructions: input.system_instruction,
    conversation: input.conversation_id ?? undefined,
    input: toolResults ? { ...userPayload, tool_results: toolResults } : userPayload,
    tools: buildOpenAIToolDefinitions(input),
  };
}

export function normalizeOpenAIResponse(raw: unknown, fallbackConversationId?: string | null): RuntimeAgentCallerOutput {
  const response = asObject(raw);
  const conversationId = readString(response?.conversation_id) ?? readString(response?.conversation) ?? fallbackConversationId;

  const toolRequests = readToolRequests(response);
  if (toolRequests.length > 0) {
    return {
      type: "tool_requests",
      conversation_id: conversationId,
      tool_requests: toolRequests,
      usage: response?.usage,
    };
  }

  const finalResponse = readFinalResponse(response);
  if (finalResponse.final_patient_reply.length > 0) {
    return {
      type: "final_response",
      conversation_id: conversationId,
      final_response: finalResponse,
      usage: response?.usage,
    };
  }

  return {
    type: "final_response",
    conversation_id: conversationId,
    final_response: {
      final_patient_reply: SAFE_FALLBACK_REPLY,
      safety_notes: ["malformed_openai_response"],
    },
    usage: response?.usage,
  };
}

function buildParameterProperties(required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  const all = [...required, ...optional];
  return Object.fromEntries(all.map((arg) => [arg, { type: "string" }]));
}

function readToolRequests(response: Record<string, unknown> | null): RuntimeAgentToolRequest[] {
  if (!response) return [];
  const fromToolCalls = toToolRequests(response.tool_calls);
  if (fromToolCalls.length > 0) return fromToolCalls;
  return toToolRequests(response.output);
}

function toToolRequests(value: unknown): RuntimeAgentToolRequest[] {
  if (!Array.isArray(value)) return [];
  const toolRequests: RuntimeAgentToolRequest[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const name = readString(obj.name) ?? readString(obj.tool) ?? readString(obj.function_name);
    if (!name || !isActiveTool(name)) continue;
    const callId = readString(obj.call_id) ?? readString(obj.id);
    const args = parseArguments(obj.arguments ?? obj.input ?? obj.parameters);
    toolRequests.push({ tool: name, call_id: callId ?? undefined, arguments: args });
  }
  return toolRequests;
}

function isActiveTool(name: string): name is (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number] {
  return ACTIVE_RUNTIME_AGENT_TOOLS.includes(name as (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number]);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asObject(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asObject(value) ?? {};
}

function readFinalResponse(response: Record<string, unknown> | null): RuntimeAgentFinalResponse {
  const final = asObject(response?.final_response);
  const outputText = readString(response?.output_text) ?? readString(final?.final_patient_reply) ?? "";
  return {
    final_patient_reply: outputText,
    language: readString(final?.language) ?? null,
    reply_reason: readString(final?.reply_reason) ?? null,
    safety_notes: toStringArray(final?.safety_notes),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((x): x is string => typeof x === "string");
}
