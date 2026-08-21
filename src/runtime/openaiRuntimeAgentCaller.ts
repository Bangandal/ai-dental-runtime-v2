import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  type AgentUiActions,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
} from "./openaiRuntimeAgent.ts";
import { parseSubjectIntent, parsePhoneOwnershipIntent } from "./bookingSubjectsState.ts";
import type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeAgentLoop.ts";
import { readResponseOutputTextDeduped } from "./openaiResponsesOutputText.ts";

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

const SELECT_SLOT_MODEL_DESCRIPTION =
  "Confirm the active patient's slot choice against active availability evidence. Call this with the exact date and time the patient affirmatively selected. Returns selection_status='selected' when the slot is in active evidence, or a failure reason otherwise. Does NOT create a visit or call ClinicCard. The runtime binds the selection to the active patient; do not provide an internal patient/subject identifier. Call booking.apply only after this tool returns selection_status='selected'.";

const BOOKING_APPLY_MODEL_DESCRIPTION =
  "Create a visit in ClinicCard for the intended patient when required booking details are present, slot selection is verified, and runtime has an acceptable booking contact. Set patient_target='self' when the sender is the patient, or patient_target='other_person' when booking for another person. Runtime owns the internal patient/subject identifier. Returns booking_status indicating whether the visit was created or why it could not be.";

const APPOINTMENT_LOOKUP_MODEL_DESCRIPTION =
  "Look up upcoming appointments for the intended patient. Set patient_target='self' for the sender's appointments, or patient_target='other_person' for another person's appointments. Runtime owns the internal patient/subject identifier. Read-only: does not create, cancel, or modify visits.";

const PATIENT_TARGET_SCHEMA = {
  type: "string",
  enum: ["self", "other_person"],
  description: "Business-semantic patient target: self for the sender/patient, other_person for another person. Runtime resolves the internal patient identity.",
} as const;

const INVALID_SEMANTIC_SUBJECT_ID = "__patient_target_conflict__";

type PatientTarget = "self" | "other_person";

export function createOpenAIRuntimeAgentCaller(deps: CreateOpenAIRuntimeAgentCallerDeps): RuntimeAgentCaller {
  return async (input) => {
    const openAIInput = buildOpenAIInput(input);
    const rawResponse = await deps.client.responses.create(openAIInput);
    return normalizeOpenAIResponse(
      rawResponse,
      input.conversation_id ?? null,
      resolveActiveBookingSubjectId(input.input.context),
    );
  };
}

function usesSemanticPatientTarget(toolName: (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number]): boolean {
  return toolName === "booking.apply" || toolName === "appointment.lookup";
}

export function buildOpenAIToolDefinitions(input: RuntimeAgentCallerInput): Array<Record<string, unknown>> {
  const defs = input.input.tool_definitions;
  if (!defs) return [];
  return ACTIVE_RUNTIME_AGENT_TOOLS.flatMap((toolName) => {
    const def = defs[toolName];
    if (!def) return [];

    // R3: subject_id stays inside the deterministic compatibility contract but is
    // removed from model-facing booking tools. select_slot needs no target argument;
    // apply/lookup receive the business-semantic patient_target instead.
    const semanticPatientTarget = usesSemanticPatientTarget(toolName);
    const removesSubjectId = toolName === "booking.select_slot" || semanticPatientTarget;
    const requiredArgs = removesSubjectId
      ? def.required_args.filter((arg) => arg !== "subject_id")
      : [...def.required_args];
    const optionalArgs = removesSubjectId
      ? def.optional_args.filter((arg) => arg !== "subject_id")
      : [...def.optional_args];

    const projectedRequiredArgs = semanticPatientTarget
      ? ["patient_target", ...requiredArgs]
      : requiredArgs;
    const description = toolName === "booking.select_slot"
      ? SELECT_SLOT_MODEL_DESCRIPTION
      : toolName === "booking.apply"
        ? BOOKING_APPLY_MODEL_DESCRIPTION
        : toolName === "appointment.lookup"
          ? APPOINTMENT_LOOKUP_MODEL_DESCRIPTION
          : def.description;
    const baseParamSchemas = (def as { param_schemas?: Record<string, Record<string, unknown>> }).param_schemas;
    const paramSchemas = semanticPatientTarget
      ? { ...(baseParamSchemas ?? {}), patient_target: PATIENT_TARGET_SCHEMA }
      : baseParamSchemas;

    return [{
      type: "function",
      name: INTERNAL_TO_OPENAI_TOOL_NAME[toolName],
      description,
      parameters: {
        type: "object",
        properties: buildParameterProperties(
          projectedRequiredArgs,
          optionalArgs,
          paramSchemas,
        ),
        required: projectedRequiredArgs,
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

export function normalizeOpenAIResponse(
  raw: unknown,
  fallbackConversationId?: string | null,
  activeBookingSubjectId: string | null = null,
): RuntimeAgentCallerOutput {
  const response = asObject(raw);
  const conversationId = readString(response?.conversation_id) ?? readString(response?.conversation) ?? fallbackConversationId;

  const toolRequests = readToolRequests(response, activeBookingSubjectId);
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

  // Valid subject_intent was parsed but the model omitted a reply field.
  // Use a safe fallback reply but do NOT mark as malformed_openai_response —
  // isMalformedFinalResponse() checks for that note and would strip the intent.
  if (finalResponse.subject_intent != null) {
    return {
      type: "final_response",
      conversation_id: conversationId,
      final_response: {
        final_patient_reply: SAFE_FALLBACK_REPLY,
        subject_intent: finalResponse.subject_intent,
        safety_notes: ["subject_intent_reply_missing"],
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

function resolveActiveBookingSubjectId(context: Record<string, unknown>): string | null {
  const runtimeContext = asObject(context.runtime_context);
  const bookingSubjects = asObject(runtimeContext?.booking_subjects);
  const candidate = readString(bookingSubjects?.active_subject_id);
  return candidate !== null && /^subject_[1-4]$/.test(candidate) ? candidate : null;
}

function readToolRequests(
  response: Record<string, unknown> | null,
  activeBookingSubjectId: string | null,
): RuntimeAgentToolRequest[] {
  if (!response) return [];
  const fromToolCalls = toToolRequests(response.tool_calls, activeBookingSubjectId);
  if (fromToolCalls.length > 0) return fromToolCalls;
  return toToolRequests(response.output, activeBookingSubjectId);
}

function readPatientTarget(args: Record<string, unknown>): { present: boolean; value: PatientTarget | null } {
  if (!Object.prototype.hasOwnProperty.call(args, "patient_target")) {
    return { present: false, value: null };
  }
  const value = args.patient_target;
  return {
    present: true,
    value: value === "self" || value === "other_person" ? value : null,
  };
}

function resolveSemanticPatientSubjectId(
  args: Record<string, unknown>,
  activeBookingSubjectId: string | null,
): string | null {
  const target = readPatientTarget(args);

  // Hidden legacy calls that do not contain patient_target keep their old subject_id
  // semantics. This is compatibility only; patient_target is required in new schemas.
  if (!target.present) {
    return typeof args.subject_id === "string" ? args.subject_id : null;
  }

  // An explicitly malformed semantic target must never fall back to a legacy ID.
  if (!target.value) return INVALID_SEMANTIC_SUBJECT_ID;

  if (!activeBookingSubjectId) {
    // subject_2 is only a compatibility bootstrap token. booking.apply may bootstrap the
    // first other person; appointment.lookup will reject it when no registry exists.
    return target.value === "self" ? "subject_1" : "subject_2";
  }

  const activeIsSelf = activeBookingSubjectId === "subject_1";
  const targetMatchesActive = target.value === "self" ? activeIsSelf : !activeIsSelf;
  return targetMatchesActive ? activeBookingSubjectId : INVALID_SEMANTIC_SUBJECT_ID;
}

function stripPatientTargetAndBindSubject(
  request: RuntimeAgentToolRequest,
  activeBookingSubjectId: string | null,
): RuntimeAgentToolRequest {
  if (request.tool !== "booking.apply" && request.tool !== "appointment.lookup") return request;

  const target = readPatientTarget(request.arguments);
  if (!target.present) return request;

  const subjectId = resolveSemanticPatientSubjectId(request.arguments, activeBookingSubjectId);
  const { patient_target: _patientTarget, subject_id: _modelSubjectId, ...businessArgs } = request.arguments;
  return {
    ...request,
    arguments: {
      ...businessArgs,
      subject_id: subjectId ?? INVALID_SEMANTIC_SUBJECT_ID,
    },
  };
}

function toToolRequests(value: unknown, activeBookingSubjectId: string | null): RuntimeAgentToolRequest[] {
  if (!Array.isArray(value)) return [];

  // Parse the whole batch first, consume semantic patient targets at this boundary, and
  // inject the old internal subject_id expected by the deterministic runtime/kernel.
  const parsedRequests: RuntimeAgentToolRequest[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) continue;
    const name = readString(obj.name) ?? readString(obj.tool) ?? readString(obj.function_name);
    if (!name) continue;
    const internalToolName = toInternalToolName(name);
    if (!internalToolName || !isActiveTool(internalToolName)) continue;
    const callId = readString(obj.call_id) ?? readString(obj.id);
    const args = parseArguments(obj.arguments ?? obj.input ?? obj.parameters);
    parsedRequests.push({ tool: internalToolName, call_id: callId ?? undefined, arguments: args });
  }

  const boundRequests = parsedRequests.map((request) =>
    stripPatientTargetAndBindSubject(request, activeBookingSubjectId));

  const batchApplySubjects = Array.from(new Set(
    boundRequests
      .filter((request) => request.tool === "booking.apply")
      .map((request) => request.arguments.subject_id)
      .filter((value): value is string => typeof value === "string" && /^subject_[1-4]$/.test(value)),
  ));
  const legacySelectSubjects = Array.from(new Set(
    boundRequests
      .filter((request) => request.tool === "booking.select_slot")
      .map((request) => request.arguments.subject_id)
      .filter((value): value is string => typeof value === "string" && /^subject_[1-4]$/.test(value)),
  ));

  // Priority is deliberate:
  // 1) persisted runtime active patient owns an established multi-person flow;
  // 2) a single same-batch booking.apply target preserves first-bootstrap behavior;
  // 3) a hidden legacy select-slot target is preserved only for backward compatibility,
  //    so old invalid subject_2-without-registry calls still fail closed in the kernel;
  // 4) otherwise simple booking is self.
  const selectSlotSubjectId = activeBookingSubjectId
    ?? (batchApplySubjects.length === 1
      ? batchApplySubjects[0]
      : legacySelectSubjects.length === 1
        ? legacySelectSubjects[0]
        : "subject_1");

  return boundRequests.map((request) => request.tool === "booking.select_slot"
    ? {
        ...request,
        arguments: { ...request.arguments, subject_id: selectSlotSubjectId },
      }
    : request);
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

  // Step 3: Normalize envelope for known subject-intent actions, then parse.
  // subject_intent may also live in response.final_response.subject_intent (structured-output path).
  const normalizedEnvelope = envelope !== null ? normalizeSubjectIntentEnvelope(envelope) : null;
  const subjectIntent =
    parseSubjectIntent(final?.subject_intent) ??
    (normalizedEnvelope !== null ? parseSubjectIntent(normalizedEnvelope) : null) ??
    undefined;

  // Step 4: Parse phone_ownership_intent from envelope or structured response.
  const phoneOwnershipIntent =
    parsePhoneOwnershipIntent(final?.phone_ownership_intent) ??
    parsePhoneOwnershipIntent(envelope?.phone_ownership_intent) ??
    undefined;

  return {
    final_patient_reply: outputText,
    language: readString(final?.language) ?? null,
    reply_reason: readString(final?.reply_reason) ?? null,
    safety_notes: toStringArray(final?.safety_notes),
    ...(ui !== undefined ? { ui } : {}),
    ...(subjectIntent !== undefined ? { subject_intent: subjectIntent } : {}),
    ...(phoneOwnershipIntent !== undefined ? { phone_ownership_intent: phoneOwnershipIntent } : {}),
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

const KNOWN_SUBJECT_ACTIONS = new Set(["none", "switch_subject", "create_subjects", "create_or_switch_subject", "start_new_episode"]);
const VALID_TARGETS = new Set(["self", "mentioned_person", "active"]);
const SUBJECT_ID_RE = /^subject_\d+$/;

/**
 * Apply bounded defaults for known subject-intent actions before parseSubjectIntent.
 * Returns null for unknown actions or when switch_subject target is unresolvable.
 * Does not invent semantics — only fills structurally missing defaults.
 */
function normalizeSubjectIntentEnvelope(obj: Record<string, unknown>): Record<string, unknown> | null {
  const action = readString(obj.action);
  if (!action || !KNOWN_SUBJECT_ACTIONS.has(action)) return null;

  if (action === "switch_subject") {
    const target = readString(obj.target);
    const subjectId = readString(obj.subject_id);
    const hasValidTarget = VALID_TARGETS.has(target ?? "");
    const hasValidSubjectId = subjectId !== null && SUBJECT_ID_RE.test(subjectId);

    // An explicit canonical subject_id is sufficient to identify the subject.
    // Normalize target to mentioned_person because applySubjectIntent prioritizes
    // intent.subject_id inside that deterministic branch.
    if (!hasValidTarget && !hasValidSubjectId) return null;
    return {
      ...obj,
      target: hasValidTarget ? target : "mentioned_person",
      ...(hasValidSubjectId ? { subject_id: subjectId } : {}),
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  if (action === "create_subjects") {
    const rawLabels = Array.isArray(obj.labels)
      ? (obj.labels as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    const rawCount = typeof obj.count === "number" ? obj.count : rawLabels.length || 1;
    const count = Math.max(1, Math.min(4, rawCount));
    return {
      ...obj,
      target: readString(obj.target) ?? "mentioned_person",
      confidence: readString(obj.confidence) ?? "medium",
      count,
      labels: rawLabels.length > 0 ? rawLabels : null,
    };
  }

  if (action === "create_or_switch_subject") {
    const target = readString(obj.target);
    return {
      ...obj,
      target: VALID_TARGETS.has(target ?? "") ? target : "mentioned_person",
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  // action === "none"
  return obj;
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
