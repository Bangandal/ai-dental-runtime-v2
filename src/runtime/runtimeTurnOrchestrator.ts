import { randomUUID } from "node:crypto";

import type { RuntimeTurnService } from "./runtimeTurnService.ts";
import type { RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import type { TurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import type { ClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import type { RuntimeContextRepository, RuntimeContext } from "./supabaseRuntimeContextRepository.ts";
import type { RuntimeTurnHttpRequestBody, RuntimeTurnHttpSuccessResponse } from "./runtimeTurnHttpRoute.ts";
import type { ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import type { AdminNotifier, AdminNotificationPayload } from "../integrations/adminNotify/adminNotifyTypes.ts";
import type { StaffRequestRepository } from "./staffRequest.ts";
import {
  initBookingSubjectsForTurn,
  postUpdateBookingSubjects,
  buildSubjectsContextPayload,
  bootstrapBookingSubjectsFromIntent,
  type BookingSubjectsState,
  type S1Seed,
  type SubjectId,
} from "./bookingSubjectsState.ts";
import { extractTypedPhone } from "./typedPhoneExtractor.ts";
import { buildModelVisibleRuntimeContext, getSemanticSessionStartedAt, isStoredSemanticItemInCurrentSession } from "./modelVisibleRuntimeContext.ts";
import { hasPriorDurablePatientTurn } from "./runtimeConversationContinuity.ts";
import { mergeAgentQualification, parseStoredAgentQualification, type AgentQualificationState } from "./agentQualification.ts";
import { withStaffRequestHandling } from "./staffRequestHandling.ts";
import { buildBookingApplyActionTruth } from "./bookingApplyGuard.ts";
import { hasTrustedPhone } from "./bookingContactGuard.ts";
import { resolveAdminNotifyReason } from "../integrations/adminNotify/adminNotifyTrigger.ts";
import { createRuntimeTurnSerialQueue, runRuntimeTurnSerialized } from "./runtimeTurnSerialQueue.ts";

export interface RuntimeTurnOrchestratorDeps {
  runtimeTurnService: RuntimeTurnService;
  runtimeTurnLogger?: RuntimeTurnLogger;
  turnPersistenceRepository?: TurnPersistenceRepository;
  clinicIdentityResolver?: ClinicIdentityResolver;
  runtimeContextRepository?: RuntimeContextRepository;
  createOpenAIConversation?: () => Promise<string | null>;
  debugEnabled?: boolean;
  adminNotifier?: AdminNotifier;
  staffRequestRepository?: StaffRequestRepository;
}

export type RuntimeTurnOrchestratorResult =
  | { outcome: "success"; payload: RuntimeTurnHttpSuccessResponse }
  | { outcome: "duplicate" }
  | { outcome: "inbound_registration_failed" }
  | { outcome: "invalid_request"; message: string }
  | { outcome: "clinic_not_found" }
  | { outcome: "error"; fallbackPayload: RuntimeTurnHttpSuccessResponse };

const RUNTIME_FALLBACK_REPLY =
  "Извините, сейчас не удалось обработать сообщение. Пожалуйста, попробуйте ещё раз или свяжитесь с клиникой напрямую.";
const runtimeTurnSerialQueue = createRuntimeTurnSerialQueue();

export function runRuntimeTurnOrchestrated(
  body: RuntimeTurnHttpRequestBody,
  deps: RuntimeTurnOrchestratorDeps,
  opts?: { trustedChannelContact?: ChannelContact; requireInboundRegistration?: boolean },
): Promise<RuntimeTurnOrchestratorResult> {
  return runRuntimeTurnSerialized({
    body,
    queue: runtimeTurnSerialQueue,
    task: () => runRuntimeTurnCore(body, deps, opts),
  });
}

async function runRuntimeTurnCore(
  body: RuntimeTurnHttpRequestBody,
  deps: RuntimeTurnOrchestratorDeps,
  opts?: { trustedChannelContact?: ChannelContact; requireInboundRegistration?: boolean },
): Promise<RuntimeTurnOrchestratorResult> {
  const startedAt = Date.now();
  const validationError = validateRuntimeTurnRequest(body);
  if (validationError) {
    void deps.runtimeTurnLogger?.logError({
      ts: new Date().toISOString(),
      status: "validation_error",
      trace_id: null,
      error_code: "invalid_runtime_turn_request",
      error_message: validationError,
      channel: readSafeField(body?.channel),
      external_user_id: readSafeField(body?.external_user_id),
      chat_id: readSafeField(body?.chat_id),
      input_text: readSafeField(body?.text),
      latency_ms: Date.now() - startedAt,
    }).catch(() => undefined);
    return { outcome: "invalid_request", message: validationError };
  }

  const validBody = body as Required<Pick<RuntimeTurnHttpRequestBody, "clinic_code" | "channel" | "text">> & RuntimeTurnHttpRequestBody;
  const resolvedClinic = await deps.clinicIdentityResolver?.resolveClinicIdentity({
    clinic_identifier: validBody.clinic_code.trim(),
  });
  if (!resolvedClinic?.ok) return { outcome: "clinic_not_found" };

  const traceId = randomUUID();
  const clinicCode = resolvedClinic.data.clinic_code;
  const channel = validBody.channel.trim();
  const externalUserId = validBody.external_user_id?.trim() || undefined;
  const chatId = validBody.chat_id?.trim() || undefined;
  const messageId = typeof validBody.meta?.message_id === "string" ? validBody.meta.message_id : "";
  const updateId = typeof validBody.meta?.update_id === "string" ? validBody.meta.update_id : "";
  const persistenceDebug: Record<string, unknown> = {};

  let canonicalContactId: string | null = null;
  let userMessageId: string | null = null;
  let runtimeContext: RuntimeContext | null = null;
  let bookingSubjectsForTurn: BookingSubjectsState | null = null;
  let providedPhoneForTurn: ProvidedPhone | null = null;
  let currentTurnTypedPhone: string | null = null;
  let previousQualification: AgentQualificationState | null = null;
  let previousBookingSubjectsSignature = stableJson(null);

  const runtimeTurnInput: Parameters<RuntimeTurnService["runTurn"]>[0] = {
    trace_id: traceId,
    clinic_id: resolvedClinic.data.clinic_id,
    contact_id: null,
    case_id: null,
    user_message: validBody.text.trim(),
    locale: readLocale(validBody.meta),
    business_context: {
      clinic_code: clinicCode,
      channel,
      chat_id: chatId,
      external_user_id: externalUserId,
      transport_contact_key: `${channel}:${externalUserId ?? chatId}`,
      meta: validBody.meta ?? {},
    },
    recent_summary: null,
  };

  if (deps.turnPersistenceRepository) {
    const contactResult = await deps.turnPersistenceRepository.getOrCreateContact({
      clinic_code: clinicCode,
      channel,
      external_user_id: externalUserId ?? null,
      chat_id: chatId ?? null,
      username: typeof validBody.meta?.username === "string" ? validBody.meta.username : null,
      first_name: typeof validBody.meta?.first_name === "string" ? validBody.meta.first_name : null,
      last_name: typeof validBody.meta?.last_name === "string" ? validBody.meta.last_name : null,
    }).catch(() => null);

    if (contactResult?.ok && isUuid(contactResult.data.contact_id)) {
      canonicalContactId = contactResult.data.contact_id;
      runtimeTurnInput.contact_id = canonicalContactId;
      if (typeof contactResult.data.clinic_id === "string") {
        runtimeTurnInput.clinic_id = contactResult.data.clinic_id;
      }
      persistenceDebug.contact = { ok: true };
    } else {
      persistenceDebug.contact = { ok: false };
    }

    if (!canonicalContactId) {
      if (opts?.requireInboundRegistration) return { outcome: "inbound_registration_failed" };
    } else {
      const dedupeKey = updateId
        ? `${channel}:${externalUserId ?? chatId ?? "unknown"}:upd:${updateId}`
        : `${channel}:${externalUserId ?? chatId ?? "unknown"}:msg:${messageId || traceId}`;
      const inboundResult = await deps.turnPersistenceRepository.registerInboundEvent({
        clinic_id: runtimeTurnInput.clinic_id,
        contact_id: canonicalContactId,
        channel,
        external_user_id: externalUserId ?? null,
        dedupe_key: dedupeKey,
        source_message_id: messageId,
        source_update_id: updateId,
        payload: {
          clinic_code: clinicCode,
          channel,
          external_user_id: externalUserId ?? null,
          chat_id: chatId ?? null,
          text: runtimeTurnInput.user_message,
          meta: validBody.meta ?? {},
        },
        trace_id: traceId,
      }).catch(() => null);

      if (opts?.requireInboundRegistration && !inboundResult?.ok) {
        return { outcome: "inbound_registration_failed" };
      }
      if (inboundResult?.ok && (inboundResult.data.is_duplicate === true || inboundResult.data.accepted === false)) {
        return { outcome: "duplicate" };
      }
      persistenceDebug.inbound_event = inboundResult?.ok ? { ok: true } : { ok: false };

      const userSave = await deps.turnPersistenceRepository.saveMessage({
        contact_id: canonicalContactId,
        direction: "inbound",
        role: "user",
        channel,
        text: runtimeTurnInput.user_message,
        message_type: "text",
        status: "created",
        provider_message_id: messageId,
        reply_to_message_id: null,
        meta: {
          trace_id: traceId,
          clinic_id: runtimeTurnInput.clinic_id,
          external_user_id: externalUserId ?? null,
          chat_id: chatId ?? null,
        },
      }).catch(() => null);
      if (userSave?.ok) userMessageId = userSave.data.message_id ?? null;
      persistenceDebug.save_user_message = userSave?.ok ? { ok: true } : { ok: false };
    }
  }

  if (canonicalContactId && deps.runtimeContextRepository) {
    const loaded = await deps.runtimeContextRepository.loadRuntimeContext({
      clinic_id: runtimeTurnInput.clinic_id,
      contact_id: canonicalContactId,
    }).catch(() => null);
    if (loaded?.ok) {
      runtimeContext = loaded.data;
      const conversationState = asRecord(runtimeContext.conversation_state);
      const collected = asRecord(conversationState.collected);
      const sessionStartedAt = getSemanticSessionStartedAt(runtimeContext.recent_history);
      const bookingSubjectsCurrent = isStoredSemanticItemInCurrentSession(
        collected.booking_subjects_updated_at,
        sessionStartedAt,
      );
      const qualificationCurrent = isStoredSemanticItemInCurrentSession(
        collected.agent_qualification_updated_at,
        sessionStartedAt,
      );
      const providedPhoneCurrent = runtimeContext.provided_phone == null
        || isStoredSemanticItemInCurrentSession(runtimeContext.provided_phone.phone_collected_at, sessionStartedAt);

      previousQualification = qualificationCurrent
        ? parseStoredAgentQualification(collected.agent_qualification)
        : null;
      previousBookingSubjectsSignature = stableJson(runtimeContext.booking_subjects);

      const detectedPhone = extractTypedPhone(runtimeTurnInput.user_message);
      currentTurnTypedPhone = detectedPhone;
      const typedPhone: ProvidedPhone | null = detectedPhone
        ? {
            phone_number: detectedPhone,
            phone_source: "typed",
            phone_trust: "unverified",
            phone_consent: false,
            phone_collected_at: new Date().toISOString(),
          }
        : null;
      providedPhoneForTurn = typedPhone ?? (providedPhoneCurrent ? runtimeContext.provided_phone : null);

      const trustedChannelContact = runtimeContext.channel_contact ?? opts?.trustedChannelContact ?? null;
      bookingSubjectsForTurn = initBookingSubjectsForTurn({
        current: bookingSubjectsCurrent ? runtimeContext.booking_subjects : null,
        channelContact: trustedChannelContact,
        pendingTypedPhone: currentTurnTypedPhone,
      });

      const visibleBase = applyMessengerPhonePolicy(
        buildModelVisibleRuntimeContext(runtimeContext),
        bookingSubjectsForTurn ? null : trustedChannelContact,
        bookingSubjectsForTurn ? null : providedPhoneForTurn,
      );
      const visibleRuntimeContext = bookingSubjectsForTurn
        ? { ...visibleBase, booking_subjects: buildSubjectsContextPayload(bookingSubjectsForTurn) }
        : visibleBase;

      runtimeTurnInput.business_context = {
        ...(runtimeTurnInput.business_context ?? {}),
        runtime_context: visibleRuntimeContext,
      };
      runtimeTurnInput.is_first_patient_turn = !hasPriorDurablePatientTurn(runtimeContext);
      if (trustedChannelContact) runtimeTurnInput.channel_contact = trustedChannelContact;
      if (providedPhoneForTurn) runtimeTurnInput.provided_phone = providedPhoneForTurn;
      if (bookingSubjectsForTurn) runtimeTurnInput.booking_subjects = bookingSubjectsForTurn;
      if (currentTurnTypedPhone) runtimeTurnInput.current_turn_typed_phone = currentTurnTypedPhone;
      if (runtimeContext.booking_subjects != null) runtimeTurnInput.had_booking_subjects = true;
      persistenceDebug.runtime_context = { ok: true };
    } else {
      persistenceDebug.runtime_context = { ok: false };
    }
  }

  if (!runtimeTurnInput.channel_contact && opts?.trustedChannelContact) {
    runtimeTurnInput.channel_contact = opts.trustedChannelContact;
  }
  if (runtimeTurnInput.is_first_patient_turn === undefined) {
    runtimeTurnInput.is_first_patient_turn = true;
  }

  // Provider conversation is deliberately turn-local. It exists only to carry function
  // calls/results within this patient turn and is never read from or persisted to Supabase.
  if (deps.createOpenAIConversation) {
    try {
      runtimeTurnInput.conversation_id = await deps.createOpenAIConversation();
    } catch {
      runtimeTurnInput.conversation_id = null;
    }
  }

  const service = withStaffRequestHandling({
    runtimeTurnService: deps.runtimeTurnService,
    staffRequestRepository: deps.staffRequestRepository,
    adminNotifier: deps.adminNotifier,
  }).runtimeTurnService;

  try {
    const result = await service.runTurn(runtimeTurnInput);
    const conversationId = result.conversation_id_resumable === false
      ? null
      : result.conversation_id ?? runtimeTurnInput.conversation_id ?? null;

    const executionSubjectId: SubjectId | null = result.execution_subject_id ?? null;
    const s1Seed = buildSenderSeed(runtimeContext);
    const preSubjects = result.booking_subjects_after_resolution
      ?? bookingSubjectsForTurn
      ?? (result.subject_intent
        ? bootstrapBookingSubjectsFromIntent(
            result.subject_intent,
            s1Seed,
            runtimeTurnInput.channel_contact ?? null,
            currentTurnTypedPhone,
          )
        : null);
    const bookingSubjectsToStore = preSubjects
      ? postUpdateBookingSubjects({
          current: preSubjects,
          toolRequests: result.tool_requests ?? [],
          toolResults: result.tool_results ?? [],
          subjectIntent: bookingSubjectsForTurn ? (result.subject_intent ?? null) : null,
          phoneOwnershipIntent: result.phone_ownership_intent ?? null,
          bookingApplyResolution: result.booking_apply_resolution ?? null,
          executionSubjectId,
        })
      : null;

    if (deps.turnPersistenceRepository && canonicalContactId) {
      const assistantSave = await deps.turnPersistenceRepository.saveMessage({
        contact_id: canonicalContactId,
        direction: "outbound",
        role: "assistant",
        channel,
        text: result.final_patient_reply,
        message_type: "text",
        status: "created",
        provider_message_id: "",
        reply_to_message_id: userMessageId,
        meta: {
          trace_id: traceId,
          conversation_id: conversationId,
        },
      }).catch(() => null);
      persistenceDebug.save_assistant_message = assistantSave?.ok ? { ok: true } : { ok: false };

      const collectedPatch: Record<string, unknown> = {};
      const nowIso = new Date().toISOString();
      if (result.qualification) {
        const mergedQualification = mergeAgentQualification(previousQualification, result.qualification);
        if (mergedQualification) {
          collectedPatch.agent_qualification = mergedQualification;
          collectedPatch.agent_qualification_updated_at = nowIso;
        }
      }
      if (result.staff_request_state?.proof.request_saved) {
        collectedPatch.agent_staff_request = result.staff_request_state;
        collectedPatch.agent_staff_request_updated_at = nowIso;
      }
      if (bookingSubjectsToStore && stableJson(bookingSubjectsToStore) !== previousBookingSubjectsSignature) {
        collectedPatch.booking_subjects_updated_at = nowIso;
      }

      const controlFlags: Record<string, unknown> = {
        ...(Object.keys(collectedPatch).length > 0 ? { collected: collectedPatch } : {}),
        ...(providedPhoneForTurn ? { provided_phone: providedPhoneForTurn } : {}),
        ...(bookingSubjectsToStore ? { booking_subjects: bookingSubjectsToStore } : {}),
        ...(runtimeTurnInput.channel_contact ? { channel_contact: runtimeTurnInput.channel_contact } : {}),
      };

      const merged = await deps.turnPersistenceRepository.mergeConversationState({
        clinic_id: runtimeTurnInput.clinic_id,
        contact_id: canonicalContactId,
        user_text: runtimeTurnInput.user_message,
        reply_text: result.final_patient_reply,
        requested_action: String(result.debug?.requested_action ?? "continue"),
        conversation_intent: String(result.debug?.last_intent ?? result.debug?.conversation_intent ?? "unknown"),
        handoff_recommended: Boolean(result.debug?.handoff_recommended ?? false),
        confidence: "medium",
        control_flags: controlFlags,
      }).catch(() => null);
      persistenceDebug.merge_state = merged?.ok ? { ok: true } : { ok: false };
    }

    const sideEffects: unknown[] = [...(result.side_effects ?? [])];
    const actionTruth = buildBookingApplyActionTruth(result.tool_results);
    if (deps.adminNotifier) {
      const notifyReason = resolveAdminNotifyReason(actionTruth);
      if (notifyReason) {
        const bookingRequest = result.tool_requests.find((request) => request.tool === "booking.apply");
        const payload: AdminNotificationPayload = {
          clinic_id: runtimeTurnInput.clinic_id,
          clinic_code: clinicCode,
          channel,
          chat_id: chatId ?? null,
          external_user_id: externalUserId ?? null,
          trace_id: traceId,
          patient_display_name: readPatientDisplayName(validBody.meta),
          phone_source: runtimeTurnInput.channel_contact?.phone_source ?? null,
          phone_available: Boolean(runtimeTurnInput.channel_contact?.phone_number),
          original_message: runtimeTurnInput.user_message,
          requested_service: readStringArg(bookingRequest?.arguments, "service"),
          requested_date: readStringArg(bookingRequest?.arguments, "requested_date"),
          requested_time: readStringArg(bookingRequest?.arguments, "requested_time"),
          booking_status: actionTruth?.booking_status ?? "unknown",
          created_visit: actionTruth?.created_visit ?? false,
          may_claim_booked: actionTruth?.may_claim_booked ?? false,
          required_next_action: actionTruth?.required_next_action ?? null,
          reason: notifyReason,
          timestamp: new Date().toISOString(),
        };
        const notification = await deps.adminNotifier.notify(payload).catch(() => ({
          type: "admin_notification" as const,
          status: "failed" as const,
          channel: "telegram" as const,
          reason: notifyReason,
          trace_id: traceId,
          error_code: "admin_notification_exception",
        }));
        sideEffects.push(notification);
      }
    }

    const rawUi = result.ui;
    const telegramContactUi = actionTruth?.required_next_action === "ask_for_phone" && channel === "telegram"
      ? { telegram: { request_contact: true as const, button_text: "📞 Поделиться контактом" } }
      : undefined;
    const mergedUi = telegramContactUi || rawUi
      ? { ...(rawUi ?? {}), ...(telegramContactUi ?? {}) }
      : undefined;
    const safeUi = hasTrustedPhone(runtimeTurnInput.channel_contact)
      && mergedUi?.telegram?.request_contact === true
      ? { ...mergedUi, telegram: { ...mergedUi.telegram, request_contact: false as const } }
      : mergedUi;

    const debug = deps.debugEnabled
      ? {
          ...(result.debug ?? {}),
          persistence: persistenceDebug,
          architecture: "agent_first_runtime_v2",
          provider_conversation_scope: "turn_local",
        }
      : undefined;
    const responsePayload: RuntimeTurnHttpSuccessResponse = {
      trace_id: traceId,
      reply_text: result.final_patient_reply,
      final_patient_reply: result.final_patient_reply,
      side_effects: sideEffects,
      ...(safeUi ? { ui: safeUi } : {}),
      ...(deps.debugEnabled ? {
        conversation_id: conversationId,
        tool_results: result.tool_results,
        debug,
      } : {}),
    };

    void deps.runtimeTurnLogger?.logTurn({
      ts: new Date().toISOString(),
      status: "ok",
      trace_id: traceId,
      clinic_id: runtimeTurnInput.clinic_id,
      contact_id: canonicalContactId ?? "contact_unavailable",
      case_id: null,
      conversation_id: conversationId,
      channel,
      external_user_id: externalUserId ?? null,
      chat_id: chatId ?? null,
      input_text: runtimeTurnInput.user_message,
      final_patient_reply: result.final_patient_reply,
      tool_results: result.tool_results,
      side_effects: sideEffects,
      debug,
      latency_ms: Date.now() - startedAt,
    }).catch(() => undefined);

    return { outcome: "success", payload: responsePayload };
  } catch (error) {
    const runtimeError = error instanceof Error ? error.message : String(error);
    const fallbackPayload: RuntimeTurnHttpSuccessResponse = {
      trace_id: traceId,
      reply_text: RUNTIME_FALLBACK_REPLY,
      final_patient_reply: RUNTIME_FALLBACK_REPLY,
      side_effects: [],
      ...(deps.debugEnabled ? { debug: { runtime_error: runtimeError } } : {}),
    };
    void deps.runtimeTurnLogger?.logError({
      ts: new Date().toISOString(),
      status: "runtime_error",
      trace_id: traceId,
      error_code: "runtime_turn_failed",
      error_message: runtimeError,
      channel,
      external_user_id: externalUserId ?? null,
      chat_id: chatId ?? null,
      input_text: runtimeTurnInput.user_message,
      fallback_reply: fallbackPayload.final_patient_reply,
      side_effects: fallbackPayload.side_effects,
      latency_ms: Date.now() - startedAt,
    }).catch(() => undefined);
    return { outcome: "error", fallbackPayload };
  }
}

export function applyMessengerPhonePolicy(
  baseContext: Record<string, unknown>,
  channelContact?: ChannelContact | null,
  providedPhone?: ProvidedPhone | null,
): Record<string, unknown> {
  const taskState = asRecord(baseContext.task_state);
  const runtimePolicy = asRecord(baseContext.runtime_policy);
  const missingFields = Array.isArray(taskState.missing_fields)
    ? taskState.missing_fields.filter((field): field is string => typeof field === "string" && field !== "phone")
    : [];
  const phonePatch = providedPhone
    ? { phone_received: true, phone_source: "typed", phone_trust: "unverified" }
    : channelContact && hasTrustedPhone(channelContact)
      ? { phone_captured: true, phone_source: channelContact.phone_source }
      : {};
  return {
    ...baseContext,
    task_state: { ...taskState, missing_fields: missingFields, ...phonePatch },
    runtime_policy: { ...runtimePolicy, phone_required: false },
  };
}

function buildSenderSeed(context: RuntimeContext | null): S1Seed | null {
  if (!context) return null;
  const known = asRecord(context.known_contact);
  const first = readSafeField(known.first_name);
  const last = readSafeField(known.last_name);
  const name = [first, last].filter(Boolean).join(" ") || null;
  return { name, service: null, slot: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function validateRuntimeTurnRequest(body: RuntimeTurnHttpRequestBody | undefined): string | null {
  if (!body) return "request body is required";
  if (!body.clinic_code?.trim()) return "clinic_code is required";
  if (!body.channel?.trim()) return "channel is required";
  if (!body.text?.trim()) return "text is required";
  if (!body.external_user_id?.trim() && !body.chat_id?.trim()) return "external_user_id or chat_id is required";
  return null;
}

function readLocale(meta: Record<string, unknown> | undefined): string | null {
  const languageCode = meta?.language_code;
  return typeof languageCode === "string" && languageCode.trim() ? languageCode.trim() : null;
}

function readSafeField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readPatientDisplayName(meta: Record<string, unknown> | undefined): string | null {
  const first = readSafeField(meta?.first_name);
  const last = readSafeField(meta?.last_name);
  return [first, last].filter(Boolean).join(" ") || null;
}

function readStringArg(args: Record<string, unknown> | undefined, key: string): string | null {
  return readSafeField(args?.[key]);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
