import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type AgentUiActions,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
} from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeAgentLoop.ts";
import { readResponseOutputTextDeduped } from "./openaiResponsesOutputText.ts";
import {
  bindModelToolRequestsToInternalContract,
  resolveActiveInternalSubjectId,
} from "./modelToolContractBridge.ts";
import { parseModelPersonIntents } from "./modelPersonIntentBridge.ts";
import { projectModelFacingContext } from "./modelFacingContextProjection.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import { parseAgentQualification } from "./agentQualification.ts";
import { parseStaffRequest } from "./staffRequest.ts";

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
  "booking.select_slot": "booking_select_slot",
  "booking.apply": "booking_apply",
  "appointment.lookup": "appointment_lookup",
};
const OPENAI_TO_INTERNAL_TOOL_NAME = Object.fromEntries(
  Object.entries(INTERNAL_TO_OPENAI_TOOL_NAME).map(([internalName, openAIName]) => [openAIName, internalName]),
) as Record<string, (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number]>;

const AGENT_FIRST_PHONE_SCHEMA = {
  type: "string",
  pattern: "^\\+?\\d{9,15}$",
  description: "Booking contact explicitly provided by the patient. Normalize it yourself to 9-15 digits with an optional leading +. Do not invent a number and omit this field when no booking contact is known.",
} as const;

export function createOpenAIRuntimeAgentCaller(deps: CreateOpenAIRuntimeAgentCallerDeps): RuntimeAgentCaller {
  return async (input) => {
    const openAIInput = buildOpenAIInput(input);
    const rawResponse = await deps.client.responses.create(openAIInput);
    return normalizeOpenAIResponse(
      rawResponse,
      input.conversation_id ?? null,
      resolveActiveInternalSubjectId(input.input.context),
      input.input.context,
    );
  };
}

export function buildOpenAIToolDefinitions(input: RuntimeAgentCallerInput): Array<Record<string, unknown>> {
  const defs = input.input.tool_definitions;
  if (!defs) return [];
  const agentFirst = isAgentFirstRuntimeEnabled();

  return ACTIVE_RUNTIME_AGENT_TOOLS.flatMap((toolName) => {
    // booking.select_slot remains an internal compatibility tool for legacy Runtime only.
    // In agent-first the model thinks in business actions: check availability, then book.
    if (agentFirst && toolName === "booking.select_slot") return [];

    const def = defs[toolName];
    if (!def) return [];

    const runtimeDefaultsUndatedAvailability = agentFirst && toolName === "availability.check";
    const requiredArgs = runtimeDefaultsUndatedAvailability
      ? def.required_args.filter((arg) => arg !== "requested_date")
      : [...def.required_args];
    const optionalArgs = [
      ...def.optional_args,
      ...(runtimeDefaultsUndatedAvailability ? ["requested_date"] : []),
      ...(agentFirst && toolName === "booking.apply" ? ["phone_number"] : []),
    ];
    const baseSchemas = (def as { param_schemas?: Record<string, Record<string, unknown>> }).param_schemas;
    const paramSchemas = agentFirst && toolName === "booking.apply"
      ? { ...(baseSchemas ?? {}), phone_number: AGENT_FIRST_PHONE_SCHEMA }
      : baseSchemas;
    let description = def.description;
    if (runtimeDefaultsUndatedAvailability) {
      description = `${description} If the patient did not specify any date, omit requested_date; Runtime applies the clinic Day+2 default. Never invent a date just to satisfy the tool schema.`;
    }
    if (agentFirst && toolName === "booking.apply") {
      description = `${description} If the patient supplied a booking phone, understand and normalize it yourself and pass it as phone_number.`;
    }

    return [{
      type: "function",
      name: INTERNAL_TO_OPENAI_TOOL_NAME[toolName],
      description,
      parameters: {
        type: "object",
        properties: buildParameterProperties(
          requiredArgs,
          optionalArgs,
          paramSchemas,
        ),
        required: requiredArgs,
        additionalProperties: true,
      },
    }];
  });
}

export function buildOpenAIInput(input: RuntimeAgentCallerInput): Record<string, unknown> {
  const payload = {
    message: input.input.message,
    context: projectModelFacingContext(input.input.context),
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

export function normalizeOpenAIResponse(
  raw: unknown,
  fallbackConversationId?: string | null,
  activeBookingSubjectId: string | null = null,
  modelContext: Record<string, unknown> | null = null,
): RuntimeAgentCallerOutput {
  const response = asObject(raw);
  const conversationObject = asObject(response?.conversation);
  const conversationId =
    readString(response?.conversation_id) ??
    readString(conversationObject?.id) ??
    readString(response?.conversation) ??
    fallbackConversationId;

  const toolRequests = readToolRequests(response, activeBookingSubjectId);
  if (toolRequests.length > 0) {
    return {
      type: "tool_requests",
      conversation_id: conversationId,
      tool_requests: toolRequests,
      usage: response?.usage,
    };
  }

  const finalResponse = readFinalResponse(response, modelContext);
  if (finalResponse.final_patient_reply.length > 0) {
    return {
      type: "final_response",
      conversation_id: conversationId,
      final_response: finalResponse,
      usage: response?.usage,
    };
  }

  const invalidStaffRequest = finalResponse.safety_notes?.includes("staff_request_invalid") === true;

  // Valid structured state was parsed but the model omitted a reply field.
  // Use a safe fallback reply but preserve already-validated structured state and
  // malformed staff-side-effect diagnostics so Runtime can still fail closed.
  if (
    finalResponse.subject_intent != null
    || finalResponse.qualification != null
    || finalResponse.staff_request != null
    || invalidStaffRequest
  ) {
    const missingReplyDiagnostic = invalidStaffRequest
      ? "staff_request_invalid"
      : finalResponse.subject_intent != null
        ? "subject_intent_reply_missing"
        : finalResponse.staff_request != null ? "staff_request_reply_missing" : "qualification_reply_missing";
    const safetyNotes = [...new Set([...(finalResponse.safety_notes ?? []), missingReplyDiagnostic])];
    return {
      type: "final_response",
      conversation_id: conversationId,
      final_response: {
        final_patient_reply: SAFE_FALLBACK_REPLY,
        ...(finalResponse.subject_intent != null ? { subject_intent: finalResponse.subject_intent } : {}),
        ...(finalResponse.phone_ownership_intent != null ? { phone_ownership_intent: finalResponse.phone_ownership_intent } : {}),
        ...(finalResponse.qualification != null ? { qualification: finalResponse.qualification } : {}),
        ...(finalResponse.staff_request != null ? { staff_request: finalResponse.staff_request } : {}),
        safety_notes: safetyNotes,
      },
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

function buildParameterProperties(
  required: readonly string[],
  optional: readonly string[],
  paramSchemas?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const all = [...required, ...optional];
  return Object.fromEntries(all.map((arg) => [arg, paramSchemas?.[arg] ?? { type: "string" }]));
}

function readToolRequests(
  response: Record<string, unknown> | null,
  activeBookingSubjectId: string | null,
): RuntimeAgentToolRequest[] {
  if (!response) return [];
  const fromToolCalls = parseToolRequests(response.tool_calls);
  if (fromToolCalls.length > 0) {
    return bindModelToolRequestsToInternalContract(fromToolCalls, activeBookingSubjectId);
  }
  return bindModelToolRequestsToInternalContract(
    parseToolRequests(response.output),
    activeBookingSubjectId,
  );
}

function parseToolRequests(value: unknown): RuntimeAgentToolRequest[] {
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
  if (isAgentFirstRuntimeEnabled() && name === "booking.select_slot") return false;
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

function readFinalResponse(
  response: Record<string, unknown> | null,
  modelContext: Record<string, unknown> | null,
): RuntimeAgentFinalResponse {
  const final = asObject(response?.final_response);
  const rawOutputText =
    readResponseOutputTextDeduped(response?.output) ??
    readString(response?.output_text) ??
    readString(final?.final_patient_reply) ??
    "";

  // Step 1: Parse the first complete JSON object from model text output.
  // The model may append a patient-facing sentence after the JSON envelope.
  const parsedEnvelope = tryParseJsonEnvelope(rawOutputText);
  const envelope = parsedEnvelope?.envelope ?? null;
  const trailingReply = parsedEnvelope?.trailingText ?? null;

  // Step 2: Extract patient reply from the envelope. If the structured reply
  // is absent, use text after the closing JSON brace. Raw JSON must never reach
  // the patient merely because the model appended trailing text.
  const outputText = envelope !== null
    ? (readString(envelope.reply) ?? readString(envelope.final_patient_reply) ?? trailingReply ?? "")
    : rawOutputText;

  const uiRaw = asObject(final?.ui ?? envelope?.ui);
  const uiTelegramRaw = asObject(uiRaw?.telegram);
  const ui: AgentUiActions | undefined = uiTelegramRaw
    ? {
        telegram: {
          ...(uiTelegramRaw.request_contact === true ? { request_contact: true } : {}),
          ...(typeof uiTelegramRaw.button_text === "string" ? { button_text: uiTelegramRaw.button_text } : {}),
        },
      }
    : undefined;

  const personIntents = parseModelPersonIntents(final, envelope, modelContext);
  const qualification = isAgentFirstRuntimeEnabled()
    ? parseAgentQualification(final?.qualification ?? envelope?.qualification, modelContext)
    : null;
  const rawStaffRequest = final?.staff_request ?? envelope?.staff_request;
  const staffRequestProposalPresent = rawStaffRequest !== undefined && rawStaffRequest !== null;
  const agentFirst = isAgentFirstRuntimeEnabled();
  const staffRequest = agentFirst ? parseStaffRequest(rawStaffRequest) : null;
  const invalidStaffRequest = agentFirst && staffRequestProposalPresent && staffRequest === null;
  const safetyNotes = [...new Set([
    ...(toStringArray(final?.safety_notes) ?? []),
    ...(invalidStaffRequest ? ["staff_request_invalid"] : []),
  ])];

  return {
    final_patient_reply: outputText,
    language: readString(final?.language) ?? null,
    reply_reason: readString(final?.reply_reason) ?? null,
    safety_notes: safetyNotes.length > 0 ? safetyNotes : undefined,
    ...(ui !== undefined ? { ui } : {}),
    ...personIntents,
    ...(qualification !== null ? { qualification } : {}),
    ...(staffRequest !== null ? { staff_request: staffRequest } : {}),
  };
}

interface ParsedJsonEnvelope {
  envelope: Record<string, unknown>;
  trailingText: string | null;
}

/**
 * Parse the first complete JSON object at the start of model text output.
 * The boundary scanner understands nested objects, quoted braces, and escapes.
 */
function tryParseJsonEnvelope(text: string): ParsedJsonEnvelope | null {
  const trimmedStart = text.trimStart();
  if (!trimmedStart.startsWith("{")) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let i = 0; i < trimmedStart.length; i += 1) {
    const char = trimmedStart[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        endIndex = i + 1;
        break;
      }
    }
  }

  if (endIndex < 0 || depth !== 0 || inString) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStart.slice(0, endIndex));
  } catch {
    return null;
  }

  const envelope = asObject(parsed);
  if (!envelope) return null;

  const trailingText = trimmedStart.slice(endIndex).trim();
  return {
    envelope,
    trailingText: trailingText.length > 0 ? trailingText : null,
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
