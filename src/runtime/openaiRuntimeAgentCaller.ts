import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type AgentUiActions,
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
const INTERNAL_TO_OPENAI_TOOL_NAME: Record<(typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number], string> = {
  "kb.search": "kb_search",
  "availability.check": "availability_check",
  "booking.apply": "booking_apply",
};
const OPENAI_TO_INTERNAL_TOOL_NAME = Object.fromEntries(
  Object.entries(INTERNAL_TO_OPENAI_TOOL_NAME).map(([internalName, openAIName]) => [openAIName, internalName]),
) as Record<string, (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number]>;

export function createOpenAIRuntimeAgentCaller(deps: CreateOpenAIRuntimeAgentCallerDeps): RuntimeAgentCaller {
  return async (input) => {
    const openAIInput = buildOpenAIInput(input);
    const rawResponse = await deps.client.responses.create(openAIInput);
    return normalizeOpenAIResponse(rawResponse, input.conversation_id ?? null);
  };
}

export function buildOpenAIToolDefinitions(input: RuntimeAgentCallerInput): Array<Record<string, unknown>> {
  const defs = input.input.tool_definitions;
  if (!defs) return [];
  return ACTIVE_RUNTIME_AGENT_TOOLS.flatMap((toolName) => {
    const def = defs[toolName];
    if (!def) return [];
    return [{
      type: "function",
      name: INTERNAL_TO_OPENAI_TOOL_NAME[toolName],
      description: def.description,
      parameters: {
        type: "object",
        properties: buildParameterProperties(def.required_args, def.optional_args),
        required: [...def.required_args],
        additionalProperties: true,
      },
    }];
  });
}

export function buildOpenAIInput(input: RuntimeAgentCallerInput): Record<string, unknown> {
  const payload = {
    message: input.input.message,
    context: input.input.context,
  };

  const responseInput: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify(payload),
        },
      ],
    },
  ];

  if (input.input.tool_results) {
    for (const toolResult of input.input.tool_results) {
      if (!toolResult.call_id) continue;
      responseInput.push({
        type: "function_call_output",
        call_id: toolResult.call_id,
        output: JSON.stringify(toolResult),
      });
    }
  }

  return {
    model: input.model,
    instructions: input.system_instruction,
    conversation: input.conversation_id ?? undefined,
    input: responseInput,
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
    if (!name) continue;
    const internalToolName = toInternalToolName(name);
    if (!internalToolName || !isActiveTool(internalToolName)) continue;
    const callId = readString(obj.call_id) ?? readString(obj.id);
    const args = parseArguments(obj.arguments ?? obj.input ?? obj.parameters);
    toolRequests.push({ tool: internalToolName, call_id: callId ?? undefined, arguments: args });
  }
  return toolRequests;
}

function toInternalToolName(name: string): string {
  return OPENAI_TO_INTERNAL_TOOL_NAME[name] ?? name;
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
  const outputText =
    readResponseOutputTextDeduped(response?.output) ??
    readString(response?.output_text) ??
    readString(final?.final_patient_reply) ??
    "";

  const uiRaw = asObject(final?.ui);
  const uiTelegramRaw = asObject(uiRaw?.telegram);
  const ui: AgentUiActions | undefined = uiTelegramRaw
    ? {
        telegram: {
          ...(uiTelegramRaw.request_contact === true ? { request_contact: true } : {}),
          ...(typeof uiTelegramRaw.button_text === "string" ? { button_text: uiTelegramRaw.button_text } : {}),
        },
      }
    : undefined;

  return {
    final_patient_reply: outputText,
    language: readString(final?.language) ?? null,
    reply_reason: readString(final?.reply_reason) ?? null,
    safety_notes: toStringArray(final?.safety_notes),
    ...(ui !== undefined ? { ui } : {}),
  };
}


// Collects all output_text parts from response.output[] in order, then:
// - if all parts are identical → return only the first (dedup model duplicate-block bug)
// - if parts differ → concatenate in order (preserve valid split output)
// - if no parts found → return null (caller falls back to response.output_text)
function readResponseOutputTextDeduped(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    if (readString(obj.type) !== "message") continue;
    const content = obj.content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      const contentObj = asObject(contentItem);
      if (!contentObj) continue;
      if (readString(contentObj.type) !== "output_text") continue;
      const text = readString(contentObj.text);
      if (text && text.length > 0) parts.push(text);
    }
  }

  if (parts.length === 0) return null;
  if (parts.every((p) => p === parts[0])) return parts[0]!;
  return parts.join("");
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
