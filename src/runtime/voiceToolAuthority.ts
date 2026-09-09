import { randomUUID } from "node:crypto";

import type { EmbeddingClient, RpcCaller } from "./supabaseKnowledgeRepository.ts";
import type { ChannelContact, RuntimeAgentToolName, RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import { createSupabaseClinicIdentityResolver, type ClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import { createSupabaseRuntimeContextRepository, type RuntimeContextRepository } from "./supabaseRuntimeContextRepository.ts";
import { createSupabaseTurnPersistenceRepository, type TurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import { createSupabaseBookingProcessStateRepository } from "./supabaseBookingProcessStateRepository.ts";
import { createSerializedBookingProcessStateRepository } from "./serializedBookingProcessStateRepository.ts";
import type { BookingProcessStateRepository } from "./bookingProcessState.ts";
import { computeBookingProcessState } from "./bookingProcessState.ts";
import { createDentalToolKernel } from "./dentalToolExecutors.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import { executeRuntimeTurnToolBatch } from "./runtimeTurnToolBatch.ts";
import { bindModelToolRequestsToInternalContract } from "./modelToolContractBridge.ts";
import {
  initBookingSubjectsForTurn,
  postUpdateBookingSubjects,
  type BookingSubjectsState,
} from "./bookingSubjectsState.ts";
import { createSupabaseStaffRequestRepository } from "./supabaseStaffRequestRepository.ts";
import { executeStaffRequestAuthority } from "./staffRequestAuthority.ts";
import { parseStaffRequest, type StaffRequestRepository } from "./staffRequest.ts";

export type VoiceAuthorityToolName =
  | "kb.search"
  | "availability.check"
  | "booking.apply"
  | "appointment.lookup"
  | "staff_request";

export interface VoiceToolAuthorityRequest {
  clinic_code: string;
  external_user_id: string;
  call_id: string;
  tool_call_id: string;
  tool: VoiceAuthorityToolName;
  arguments: Record<string, unknown>;
  /** Verified SIP caller supplied by the private voice controller. Never model-supplied. */
  caller_phone?: string | null;
  locale?: string | null;
}

export type VoiceToolAuthorityResponse =
  | {
      ok: true;
      trace_id: string;
      tool_result: unknown;
      live_transfer_authorized?: boolean;
      staff_request_proof?: unknown;
      state_persisted?: boolean;
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

export interface VoiceToolAuthorityDeps {
  clinicIdentityResolver: ClinicIdentityResolver;
  turnPersistenceRepository: TurnPersistenceRepository;
  runtimeContextRepository: RuntimeContextRepository;
  bookingProcessStateRepository: BookingProcessStateRepository;
  executors: ToolExecutorRegistry;
  staffRequestRepository?: StaffRequestRepository;
  timezone?: string;
  now?: () => Date;
}

export interface CreateVoiceToolAuthorityFromRuntimeDeps {
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  timezone?: string;
}

const VOICE_RUNTIME_TOOLS = new Set<RuntimeAgentToolName>([
  "kb.search",
  "availability.check",
  "booking.apply",
  "appointment.lookup",
]);
const E164 = /^\+[1-9]\d{7,14}$/;

export function createVoiceToolAuthorityFromRuntimeDeps(
  deps: CreateVoiceToolAuthorityFromRuntimeDeps,
): (request: VoiceToolAuthorityRequest) => Promise<VoiceToolAuthorityResponse> {
  const baseStateRepository = createSerializedBookingProcessStateRepository(
    createSupabaseBookingProcessStateRepository({ rpc: deps.rpc }),
  );
  const kernel = createDentalToolKernel({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
    bookingProcessStateRepository: baseStateRepository,
  });

  return createVoiceToolAuthority({
    clinicIdentityResolver: createSupabaseClinicIdentityResolver({ rpc: deps.rpc }),
    turnPersistenceRepository: createSupabaseTurnPersistenceRepository({ rpc: deps.rpc }),
    runtimeContextRepository: createSupabaseRuntimeContextRepository({ rpc: deps.rpc }),
    bookingProcessStateRepository: kernel.bookingProcessStateRepository ?? baseStateRepository,
    executors: kernel.executors,
    staffRequestRepository: createSupabaseStaffRequestRepository({ rpc: deps.rpc }),
    timezone: deps.timezone,
  });
}

/**
 * LLM-free voice action authority. Realtime owns conversation; this service owns truth,
 * identity, slot evidence, booking writes and durable staff requests.
 */
export function createVoiceToolAuthority(
  deps: VoiceToolAuthorityDeps,
): (request: VoiceToolAuthorityRequest) => Promise<VoiceToolAuthorityResponse> {
  return async (body) => {
    const validationError = validateVoiceToolRequest(body);
    if (validationError) return fail("invalid_voice_tool_request", validationError);

    const resolvedClinic = await deps.clinicIdentityResolver.resolveClinicIdentity({
      clinic_identifier: body.clinic_code.trim(),
    }).catch(() => null);
    if (!resolvedClinic?.ok) return fail("unknown_clinic", "Clinic could not be resolved");

    const contact = await deps.turnPersistenceRepository.getOrCreateContact({
      clinic_code: resolvedClinic.data.clinic_code,
      channel: "voice",
      external_user_id: body.external_user_id,
      chat_id: null,
      username: null,
      first_name: null,
      last_name: null,
    }).catch(() => null);
    if (!contact?.ok || !isUuid(contact.data.contact_id)) {
      return fail("voice_contact_unavailable", "Voice contact could not be resolved");
    }

    const clinicId = contact.data.clinic_id ?? resolvedClinic.data.clinic_id;
    const contactId = contact.data.contact_id;
    const traceId = randomUUID();
    const now = deps.now?.() ?? new Date();
    const timezone = deps.timezone ?? "Europe/Prague";
    const channelContact: ChannelContact | null = body.caller_phone && E164.test(body.caller_phone)
      ? {
          phone_number: body.caller_phone,
          // The value is Runtime-owned and originates only from a verified SIP webhook.
          phone_source: "voice_sip_caller" as ChannelContact["phone_source"],
          phone_consent: true,
          phone_collected_at: now.toISOString(),
        }
      : null;

    if (body.tool === "staff_request") {
      const request = parseStaffRequest(body.arguments);
      if (!request) return fail("invalid_staff_request", "Staff request arguments are invalid");

      const authority = await executeStaffRequestAuthority({
        clinic_id: clinicId,
        clinic_code: resolvedClinic.data.clinic_code,
        contact_id: contactId,
        trace_id: traceId,
        idempotency_key: `voice:${body.external_user_id}:call:${body.call_id}:tool:${body.tool_call_id}`,
        channel: "voice",
        external_user_id: body.external_user_id,
        source_message: request.summary,
        request,
        channel_contact: channelContact,
        repository: deps.staffRequestRepository,
      });

      return {
        ok: true,
        trace_id: traceId,
        tool_result: {
          tool: "staff_request",
          status: authority.proof.request_saved ? "success" : "failed",
          data: {
            kind: request.kind,
            request_saved: authority.proof.request_saved,
            notification_queued: authority.proof.notification_queued === true,
            may_claim_notified: authority.proof.may_claim_notified,
          },
        },
        staff_request_proof: authority.proof,
        live_transfer_authorized:
          request.kind === "live_transfer" && authority.proof.request_saved === true,
      };
    }

    if (!VOICE_RUNTIME_TOOLS.has(body.tool as RuntimeAgentToolName)) {
      return fail("voice_tool_not_allowed", "Tool is not available to the voice surface");
    }

    const loadedContext = await deps.runtimeContextRepository.loadRuntimeContext({
      clinic_id: clinicId,
      contact_id: contactId,
    }).catch(() => null);
    const durableContext = loadedContext?.ok ? loadedContext.data : null;
    const bookingSubjects = initBookingSubjectsForTurn({
      current: durableContext?.booking_subjects ?? null,
      channelContact,
      pendingTypedPhone: null,
    });

    const modelRequest: RuntimeAgentToolRequest = {
      tool: body.tool as RuntimeAgentToolName,
      call_id: body.tool_call_id,
      arguments: { ...body.arguments },
    };
    const [request] = bindModelToolRequestsToInternalContract(
      [modelRequest],
      bookingSubjects?.active_subject_id ?? null,
    );

    let bookingStateLoadFailed = false;
    const priorBookingState = await deps.bookingProcessStateRepository.loadState(
      { clinic_id: clinicId, contact_id: contactId, case_id: null },
      (info) => {
        if (!info.loaded && info.reason === "rpc_error") bookingStateLoadFailed = true;
      },
    ).catch(() => {
      bookingStateLoadFailed = true;
      return null;
    });
    if (bookingStateLoadFailed) {
      return fail("booking_state_unavailable", "Booking state could not be loaded safely");
    }

    const initialBookingState = computeBookingProcessState({
      prior: priorBookingState,
      channelContact,
      now,
    });

    const runtimeInput = {
      trace_id: traceId,
      clinic_id: clinicId,
      contact_id: contactId,
      case_id: null,
      user_message: "[voice tool call]",
      locale: body.locale ?? null,
      business_context: {
        clinic_code: resolvedClinic.data.clinic_code,
        channel: "voice",
        external_user_id: body.external_user_id,
        meta: { call_id: body.call_id, tool_call_id: body.tool_call_id },
      },
      channel_contact: channelContact ?? undefined,
      booking_subjects: bookingSubjects,
      had_booking_subjects: durableContext?.booking_subjects != null,
    };

    const batch = await executeRuntimeTurnToolBatch({
      requests: [request],
      input: runtimeInput,
      executors: deps.executors,
      booking_process_state: initialBookingState,
      booking_subjects: bookingSubjects,
      now,
      timezone,
    });

    let statePersisted = true;
    await deps.bookingProcessStateRepository.saveState(
      { clinic_id: clinicId, contact_id: contactId, case_id: null },
      batch.booking_process_state,
      (info) => { if (!info.saved) statePersisted = false; },
    ).catch(() => { statePersisted = false; });

    await persistVoiceSubjectState({
      deps,
      clinic_id: clinicId,
      contact_id: contactId,
      previous: durableContext?.booking_subjects ?? null,
      initialized: bookingSubjects,
      batch,
      request,
    });

    const toolResult = batch.tool_results.find((result) => result.call_id === body.tool_call_id)
      ?? batch.tool_results[batch.tool_results.length - 1]
      ?? {
        tool: request.tool,
        call_id: body.tool_call_id,
        status: "failed" as const,
        error: { code: "missing_tool_result", message: "Runtime produced no tool result" },
      };

    return {
      ok: true,
      trace_id: traceId,
      tool_result: toolResult,
      state_persisted: statePersisted,
    };
  };
}

async function persistVoiceSubjectState(params: {
  deps: VoiceToolAuthorityDeps;
  clinic_id: string;
  contact_id: string;
  previous: BookingSubjectsState | null;
  initialized: BookingSubjectsState | null;
  batch: Awaited<ReturnType<typeof executeRuntimeTurnToolBatch>>;
  request: RuntimeAgentToolRequest;
}): Promise<void> {
  const base = params.batch.effective_booking_subjects ?? params.initialized;
  if (!base) return;

  const updated = postUpdateBookingSubjects({
    current: base,
    toolRequests: [params.request],
    toolResults: params.batch.tool_results,
    bookingApplyResolution: params.batch.booking_apply_resolution,
    executionSubjectId: params.batch.execution_subject_id,
  });
  const durableUpdated = stripEphemeralVoiceContacts(updated);
  if (JSON.stringify(durableUpdated) === JSON.stringify(params.previous)) return;

  await params.deps.turnPersistenceRepository.mergeConversationState({
    clinic_id: params.clinic_id,
    contact_id: params.contact_id,
    user_text: "",
    reply_text: "",
    requested_action: "voice_tool",
    conversation_intent: "voice_tool",
    handoff_recommended: false,
    confidence: "high",
    control_flags: { booking_subjects: durableUpdated },
  }).catch(() => null);
}

/** SIP caller numbers are transport proofs, not durable semantic subject state. */
function stripEphemeralVoiceContacts(state: BookingSubjectsState): BookingSubjectsState {
  return {
    ...state,
    subjects: state.subjects.map((subject) => {
      if (subject.booking_contact?.source !== ("voice_sip_caller" as never)) return subject;
      const withoutContact = { ...subject, booking_contact: null };
      const missing = [...withoutContact.missing.filter((item) => item !== "booking_contact"), "booking_contact"];
      return { ...withoutContact, missing: [...new Set(missing)] };
    }),
  };
}

function validateVoiceToolRequest(body: VoiceToolAuthorityRequest): string | null {
  if (!body || typeof body !== "object") return "request body is required";
  if (typeof body.clinic_code !== "string" || !body.clinic_code.trim()) return "clinic_code is required";
  if (typeof body.external_user_id !== "string" || !body.external_user_id.trim()) return "external_user_id is required";
  if (typeof body.call_id !== "string" || !body.call_id.trim()) return "call_id is required";
  if (typeof body.tool_call_id !== "string" || !body.tool_call_id.trim()) return "tool_call_id is required";
  if (typeof body.tool !== "string" || !body.tool.trim()) return "tool is required";
  if (!body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) return "arguments must be an object";
  if (body.caller_phone != null && (typeof body.caller_phone !== "string" || !E164.test(body.caller_phone))) {
    return "caller_phone must be E.164 when provided";
  }
  return null;
}

function fail(code: string, message: string): VoiceToolAuthorityResponse {
  return { ok: false, error: { code, message } };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
