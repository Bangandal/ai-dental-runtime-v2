import { randomUUID } from "node:crypto";

import type { RuntimeTurnInput, RuntimeTurnService } from "./runtimeTurnService.ts";
import type { RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import type { OpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import type { TurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import type { ClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import type { RuntimeContextRepository } from "./supabaseRuntimeContextRepository.ts";
import type { CaseContextRepository } from "./supabaseCaseContextRepository.ts";
import type { CaseRouterClassifier } from "./caseRouterShadow.ts";
import type { RuntimeGateClassifier } from "./runtimeGateShadow.ts";
import type { TurnUnderstandingClassifier } from "./turnUnderstandingShadow.ts";
import { buildModelVisibleRuntimeContext } from "./modelVisibleRuntimeContext.ts";
import { isLegacyCaseRouterEnabled, runCaseRouterShadow, sanitizeCaseRouterContext } from "./caseRouterShadow.ts";
import { runRuntimeGateShadow, sanitizeRuntimeGateContext } from "./runtimeGateShadow.ts";
import { runTurnUnderstandingShadow, sanitizeTurnUnderstandingContext } from "./turnUnderstandingShadow.ts";
import { buildReplyContextShadow } from "./replyContextBuilderShadow.ts";
import { buildTopicMemoryCandidateShadow, buildTopicMemoryPatch } from "./topicMemoryCandidateShadow.ts";
import { buildRuntimeLlmCallDebug, mergeRuntimeLlmCallDebug } from "./llmCallDebug.ts";
import type { RuntimeTurnHttpRequestBody, RuntimeTurnHttpSuccessResponse } from "./runtimeTurnHttpRoute.ts";
import { buildBookingApplyActionTruth } from "./bookingApplyGuard.ts";
import { resolveAdminNotifyReason } from "../integrations/adminNotify/adminNotifyTrigger.ts";
import type { AdminNotifier, AdminNotificationPayload } from "../integrations/adminNotify/adminNotifyTypes.ts";

export interface RuntimeTurnOrchestratorDeps {
  runtimeTurnService: RuntimeTurnService;
  runtimeTurnLogger?: RuntimeTurnLogger;
  openAIConversationMemoryRepository?: OpenAIConversationMemoryRepository;
  createOpenAIConversation?: () => Promise<string | null>;
  turnPersistenceRepository?: TurnPersistenceRepository;
  clinicIdentityResolver?: ClinicIdentityResolver;
  runtimeContextRepository?: RuntimeContextRepository;
  caseContextRepository?: CaseContextRepository;
  caseRouterClassifier?: CaseRouterClassifier;
  runtimeGateClassifier?: RuntimeGateClassifier;
  turnUnderstandingClassifier?: TurnUnderstandingClassifier;
  debugEnabled?: boolean;
  adminNotifier?: AdminNotifier;
}

export type RuntimeTurnOrchestratorResult =
  | { outcome: "success"; payload: RuntimeTurnHttpSuccessResponse }
  | { outcome: "duplicate" }
  | { outcome: "invalid_request"; message: string }
  | { outcome: "clinic_not_found" }
  | { outcome: "error"; fallbackPayload: RuntimeTurnHttpSuccessResponse };

const RUNTIME_FALLBACK_REPLY =
  "Извините, сейчас не удалось обработать сообщение. Администратор проверит вручную.";

export async function runRuntimeTurnOrchestrated(
  body: RuntimeTurnHttpRequestBody,
  deps: RuntimeTurnOrchestratorDeps,
): Promise<RuntimeTurnOrchestratorResult> {
  const startTime = Date.now();

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
      latency_ms: Date.now() - startTime,
    }).catch(() => undefined);
    return { outcome: "invalid_request", message: validationError };
  }

  const validBody = body as Required<Pick<RuntimeTurnHttpRequestBody, "clinic_code" | "channel" | "text">> &
    RuntimeTurnHttpRequestBody;

  const clinicIdentifier = validBody.clinic_code.trim();
  const resolvedClinic = await deps.clinicIdentityResolver?.resolveClinicIdentity({ clinic_identifier: clinicIdentifier });
  if (!resolvedClinic || !resolvedClinic.ok) {
    return { outcome: "clinic_not_found" };
  }

  const traceId = randomUUID();
  const externalUserId = validBody.external_user_id?.trim() || undefined;
  const chatId = validBody.chat_id?.trim() || undefined;

  const persistenceDebug: Record<string, unknown> = {};
  const turnLlmCalls = buildRuntimeLlmCallDebug();

  const transportContactKey = `${validBody.channel.trim()}:${externalUserId ?? chatId}`;
  let canonicalContactId: string | null = null;
  const runtimeTurnInput: RuntimeTurnInput = {
    trace_id: traceId,
    clinic_id: resolvedClinic.data.clinic_id,
    contact_id: null,
    case_id: null,
    user_message: validBody.text.trim(),
    locale: readLocale(validBody.meta),
    business_context: {
      channel: validBody.channel.trim(),
      chat_id: chatId,
      external_user_id: externalUserId,
      transport_contact_key: transportContactKey,
      meta: validBody.meta,
    },
    recent_summary: null,
  };

  const clinicCode = resolvedClinic.data.clinic_code;
  const messageId = typeof validBody.meta?.message_id === "string" ? validBody.meta.message_id : "";
  const updateId = typeof validBody.meta?.update_id === "string" ? validBody.meta.update_id : "";
  let userMessageId: string | null = null;

  if (deps.turnPersistenceRepository) {
    const contactResult = await deps.turnPersistenceRepository.getOrCreateContact({
      clinic_code: clinicCode,
      channel: validBody.channel.trim(),
      external_user_id: externalUserId ?? null,
      chat_id: chatId ?? null,
      username: typeof validBody.meta?.username === "string" ? validBody.meta.username : null,
      first_name: typeof validBody.meta?.first_name === "string" ? validBody.meta.first_name : null,
      last_name: typeof validBody.meta?.last_name === "string" ? validBody.meta.last_name : null,
    }).catch((error) => ({ ok: false, error: { code: "contact_persist_exception", message: error instanceof Error ? error.message : String(error), retryable: true } } as const));
    persistenceDebug.contact = contactResult.ok && isUuid(contactResult.data.contact_id) ? { ok: true } : { ok: false, code: contactResult.ok ? "contact_id_not_uuid" : contactResult.error.code };
    if (contactResult.ok && isUuid(contactResult.data.contact_id)) {
      canonicalContactId = contactResult.data.contact_id;
      runtimeTurnInput.contact_id = canonicalContactId;
      if (typeof (contactResult.data as Record<string, unknown>).clinic_id === "string") {
        runtimeTurnInput.clinic_id = (contactResult.data as Record<string, string>).clinic_id;
      }
    }
    const contactIdForPre = canonicalContactId;
    const dedupeKey = updateId
      ? `${runtimeTurnInput.business_context.channel}:${externalUserId ?? "unknown"}:upd:${updateId}`
      : `${runtimeTurnInput.business_context.channel}:${externalUserId ?? "unknown"}:msg:${messageId || traceId}`;
    if (contactIdForPre) {
      const inboundResult = await deps.turnPersistenceRepository.registerInboundEvent({
        clinic_id: runtimeTurnInput.clinic_id,
        contact_id: contactIdForPre,
        channel: runtimeTurnInput.business_context.channel,
        external_user_id: externalUserId ?? null,
        dedupe_key: dedupeKey,
        source_message_id: messageId,
        source_update_id: updateId,
        payload: {
          clinic_code: clinicCode,
          channel: runtimeTurnInput.business_context.channel,
          external_user_id: externalUserId ?? null,
          chat_id: chatId ?? null,
          text: runtimeTurnInput.user_message,
          meta: validBody.meta ?? {},
        },
        trace_id: traceId,
      }).catch(() => ({ ok: false } as const));

      // null inbound_event_id indicates the event was already registered (duplicate update/message).
      if (inboundResult.ok && inboundResult.data.inbound_event_id === null) {
        return { outcome: "duplicate" };
      }

      persistenceDebug.inbound_event = inboundResult.ok ? { ok: true } : { ok: false, code: "inbound_event_persist_failed" };
      const userMsgResult = await deps.turnPersistenceRepository.saveMessage({
        contact_id: contactIdForPre,
        direction: "inbound",
        role: "user",
        channel: runtimeTurnInput.business_context.channel,
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
      }).catch(() => ({ ok: false } as const));
      persistenceDebug.save_user_message = userMsgResult.ok ? { ok: true } : { ok: false, code: "message_persist_failed" };
      userMessageId = userMsgResult.ok ? userMsgResult.data.message_id ?? null : null;
    } else {
      persistenceDebug.inbound_event = { ok: false, skipped: true, reason: "contact_unavailable" };
      persistenceDebug.save_user_message = { ok: false, skipped: true, reason: "contact_unavailable" };
    }
  }

  const memoryDebug: Record<string, unknown> = {};

  if (deps.openAIConversationMemoryRepository) {
    try {
      const loadedMemory = await deps.openAIConversationMemoryRepository.getConversationMemory({
        clinic_id: resolvedClinic.data.clinic_id,
        channel: validBody.channel.trim(),
        external_user_id: externalUserId ?? null,
        chat_id: chatId ?? null,
      });
      memoryDebug.memory_lookup = {
        ok: loadedMemory.ok,
        clinic_id: resolvedClinic.data.clinic_id,
        channel: validBody.channel.trim(),
        external_user_id: externalUserId ?? null,
        chat_id: chatId ?? null,
        conversation_id: loadedMemory.ok ? loadedMemory.data.conversation_id : null,
        error: loadedMemory.ok ? null : loadedMemory.error,
      };
      if (loadedMemory.ok && loadedMemory.data.conversation_id) {
        runtimeTurnInput.conversation_id = loadedMemory.data.conversation_id;
      }
    } catch (error) {
      memoryDebug.memory_lookup = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Determine first-patient-turn BEFORE createOpenAIConversation may assign a fresh conversation_id.
  // True only when a memory repository is wired (so we have a reliable signal) and no prior
  // conversation was found for this contact. This flag is passed to runTurn so the agent can
  // give a first-turn self-introduction without relying on conversation_id being null.
  runtimeTurnInput.is_first_patient_turn =
    deps.openAIConversationMemoryRepository != null && !runtimeTurnInput.conversation_id;

  const caseContextDebug: Record<string, unknown> = { loaded: false, open_cases_count: 0, recent_cases_count: 0, has_current_case: false, current_case_resolved: false, has_active_hold: false, has_latest_appointment: false };
  let loadedCaseContext: unknown = null;
  if (!canonicalContactId) {
    caseContextDebug.skip_reason = "contact_unavailable";
  } else if (deps.caseContextRepository) {
    try {
      const caseContextResult = await deps.caseContextRepository.loadCaseContext({ clinic_id: runtimeTurnInput.clinic_id, contact_id: canonicalContactId });
      caseContextDebug.loaded = caseContextResult.ok;
      if (caseContextResult.ok) {
        loadedCaseContext = caseContextResult.data;
        const openCases = caseContextResult.data.open_cases ?? [];
        const recentCases = caseContextResult.data.recent_cases ?? [];
        caseContextDebug.open_cases_count = openCases.length;
        caseContextDebug.recent_cases_count = recentCases.length;
        caseContextDebug.has_current_case = Boolean(caseContextResult.data.current_case_id);
        caseContextDebug.current_case_resolved = openCases.some((openCase) => asString((openCase as Record<string, unknown>).case_id) === asString(caseContextResult.data.current_case_id));
        caseContextDebug.has_active_hold = Boolean(caseContextResult.data.active_booking_context.active_hold);
        caseContextDebug.has_latest_appointment = Boolean(caseContextResult.data.active_booking_context.latest_appointment);
      } else {
        caseContextDebug.error = caseContextResult.error;
      }
    } catch (error) {
      caseContextDebug.loaded = false;
      caseContextDebug.error = { code: "case_context_exception", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const runtimeContextDebug: Record<string, unknown> = { loaded: false, source: "supabase", recent_history_count: 0, topic_memory: null };
  let runtimeGateSourceContext: unknown = null;
  if (!canonicalContactId) {
    runtimeContextDebug.skip_reason = "contact_unavailable";
  } else if (deps.runtimeContextRepository) {
    try {
      const runtimeContextResult = await deps.runtimeContextRepository.loadRuntimeContext({ clinic_id: runtimeTurnInput.clinic_id, contact_id: canonicalContactId });
      runtimeContextDebug.loaded = runtimeContextResult.ok;
      if (runtimeContextResult.ok) {
        runtimeContextDebug.state_version = (runtimeContextResult.data.conversation_state as Record<string, unknown>).state_version ?? null;
        runtimeContextDebug.recent_history_count = runtimeContextResult.data.recent_history.length;
        runtimeContextDebug.topic_memory = runtimeContextResult.data.topic_memory ?? null;
        runtimeGateSourceContext = mergeCaseContextIntoModelContext(asRecord(runtimeContextResult.data), loadedCaseContext);
        runtimeTurnInput.business_context = {
          ...(runtimeTurnInput.business_context ?? {}),
          runtime_context: mergeCaseContextIntoModelContext(
            applyMessengerPhonePolicy(buildModelVisibleRuntimeContext(runtimeContextResult.data)),
            loadedCaseContext,
          ),
        };
        if (runtimeContextResult.data.channel_contact) {
          runtimeTurnInput.channel_contact = runtimeContextResult.data.channel_contact;
        }
      } else {
        runtimeContextDebug.error = runtimeContextResult.error;
      }
    } catch (error) {
      runtimeContextDebug.loaded = false;
      runtimeContextDebug.error = { code: "runtime_context_exception", message: error instanceof Error ? error.message : String(error) };
    }
  }

  if (loadedCaseContext && !(runtimeTurnInput.business_context as Record<string, unknown>).runtime_context) {
    const caseOnlyContext = mergeCaseContextIntoModelContext({}, loadedCaseContext);
    runtimeGateSourceContext = caseOnlyContext;
    runtimeTurnInput.business_context = { ...(runtimeTurnInput.business_context ?? {}), runtime_context: caseOnlyContext };
  }

  const runtimeGateContext = sanitizeRuntimeGateContext(runtimeGateSourceContext ?? (runtimeTurnInput.business_context as Record<string, unknown>).runtime_context);
  const runtimeGateDebug = await runRuntimeGateShadow({
    user_message: runtimeTurnInput.user_message,
    runtime_context: runtimeGateContext,
    classifier: deps.runtimeGateClassifier,
  });
  turnLlmCalls.runtime_gate_called = Boolean(deps.runtimeGateClassifier);

  const turnUnderstandingInput = sanitizeTurnUnderstandingContext({
    user_message: runtimeTurnInput.user_message,
    runtime_gate: runtimeGateDebug,
    runtime_context: runtimeGateSourceContext ?? (runtimeTurnInput.business_context as Record<string, unknown>).runtime_context,
  });
  const turnUnderstandingDebug = await runTurnUnderstandingShadow({
    user_message: runtimeTurnInput.user_message,
    runtime_gate: runtimeGateDebug,
    runtime_context: turnUnderstandingInput.runtime_context,
    classifier: deps.turnUnderstandingClassifier,
  });
  turnLlmCalls.turn_understanding_called = runtimeGateDebug.route === "operational_candidate" && Boolean(deps.turnUnderstandingClassifier);
  const topicMemoryCandidateDebug = buildTopicMemoryCandidateShadow({
    user_message: runtimeTurnInput.user_message,
    runtime_gate: runtimeGateDebug,
    turn_understanding: turnUnderstandingDebug,
  });
  const topicMemoryPatch = buildTopicMemoryPatch(topicMemoryCandidateDebug, new Date());
  persistenceDebug.topic_memory = topicMemoryPatch
    ? { ok: false, skipped: true, reason: "turn_persistence_repository_unavailable" }
    : { ok: false, skipped: true, reason: topicMemoryCandidateDebug.reason ?? "topic_memory_candidate_no_update" };
  const replyContextBuilderDebug = buildReplyContextShadow({
    runtime_gate: runtimeGateDebug,
    turn_understanding: turnUnderstandingDebug,
  });

  const classifierInputContext = sanitizeCaseRouterContext((runtimeTurnInput.business_context as Record<string, unknown>).runtime_context);
  const legacyCaseRouterEnabled = isLegacyCaseRouterEnabled();
  const caseRouterDebug = await runCaseRouterShadow({
    user_message: runtimeTurnInput.user_message,
    runtime_context: classifierInputContext,
    classifier: deps.caseRouterClassifier,
    enabled: legacyCaseRouterEnabled,
  });
  turnLlmCalls.legacy_case_router_called = legacyCaseRouterEnabled && Boolean(deps.caseRouterClassifier);

  if (!runtimeTurnInput.conversation_id && deps.createOpenAIConversation) {
    try {
      const createdConversationId = await deps.createOpenAIConversation();
      if (createdConversationId) {
        runtimeTurnInput.conversation_id = createdConversationId;
      }
    } catch {
      // non-fatal by contract
    }
  }

  try {
    const result = await deps.runtimeTurnService.runTurn(runtimeTurnInput);
    // conversation_id_resumable===false means this turn's conversation_id has a pending
    // function_call with no function_call_output submitted (see runtimeAgentLoop's
    // forced-finalization branches) — resuming it later fails upstream with a 400
    // "No tool output found for function call ...". Do not fall back to whatever was
    // already loaded into runtimeTurnInput.conversation_id in that case; start clean.
    const isConversationDirty = result.conversation_id_resumable === false;
    const conversationIdToPersist = isConversationDirty
      ? null
      : result.conversation_id ?? runtimeTurnInput.conversation_id ?? null;
    // If a conversation_id was already stored from an earlier turn and this turn just made
    // it dirty, skipping the save would leave the stale value in place — the next turn would
    // load and resume it, reproducing the same upstream 400. Explicitly clear it instead.
    const shouldClearStoredConversation = isConversationDirty && Boolean(runtimeTurnInput.conversation_id);
    if ((conversationIdToPersist || shouldClearStoredConversation) && deps.openAIConversationMemoryRepository) {
      try {
        const memorySaveResult = await deps.openAIConversationMemoryRepository.saveConversationMemory({
          clinic_id: runtimeTurnInput.clinic_id,
          channel: runtimeTurnInput.business_context.channel,
          external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
          chat_id: runtimeTurnInput.business_context.chat_id ?? null,
          conversation_id: conversationIdToPersist ?? "",
        });
        memoryDebug.memory_save = {
          ok: memorySaveResult.ok,
          conversation_id: conversationIdToPersist,
          cleared_dirty_conversation: shouldClearStoredConversation,
          error: memorySaveResult.ok ? null : memorySaveResult.error,
        };
      } catch (error) {
        memoryDebug.memory_save = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (deps.turnPersistenceRepository && canonicalContactId) {
      const assistantSave = await deps.turnPersistenceRepository.saveMessage({
        contact_id: canonicalContactId,
        direction: "outbound",
        role: "assistant",
        channel: runtimeTurnInput.business_context.channel,
        text: result.final_patient_reply,
        message_type: "text",
        status: "created",
        provider_message_id: "",
        reply_to_message_id: userMessageId,
        meta: {
          trace_id: traceId,
          openai_conversation_id: conversationIdToPersist,
          last_intent: (result.debug as Record<string, unknown> | undefined)?.last_intent ?? null,
          conversation_intent: (result.debug as Record<string, unknown> | undefined)?.conversation_intent ?? null,
        },
      }).catch(() => ({ ok: false } as const));
      persistenceDebug.save_assistant_message = assistantSave.ok ? { ok: true } : { ok: false, code: "message_persist_failed" };
      const mergeState = await deps.turnPersistenceRepository.mergeConversationState({
        clinic_id: runtimeTurnInput.clinic_id,
        contact_id: canonicalContactId,
        user_text: runtimeTurnInput.user_message,
        reply_text: result.final_patient_reply,
        requested_action: String((result.debug as Record<string, unknown> | undefined)?.requested_action ?? "continue"),
        conversation_intent: String((result.debug as Record<string, unknown> | undefined)?.last_intent ?? (result.debug as Record<string, unknown> | undefined)?.conversation_intent ?? "unknown"),
        handoff_recommended: Boolean((result.debug as Record<string, unknown> | undefined)?.handoff_recommended ?? false),
        confidence: "medium",
        control_flags: { openai_conversation_id: conversationIdToPersist },
        topic_memory_patch: topicMemoryPatch,
      }).catch(() => ({ ok: false } as const));
      persistenceDebug.merge_state = mergeState.ok ? { ok: true } : { ok: false, code: "convo_state_persist_failed" };
      if (topicMemoryPatch) {
        persistenceDebug.topic_memory = mergeState.ok
          ? { ok: true, skipped: false, reason: null }
          : { ok: false, skipped: false, reason: "convo_state_persist_failed" };
      }
    } else if (deps.turnPersistenceRepository) {
      persistenceDebug.save_assistant_message = { ok: false, skipped: true, reason: "contact_unavailable" };
      persistenceDebug.merge_state = { ok: false, skipped: true, reason: "contact_unavailable" };
      if (topicMemoryPatch) {
        persistenceDebug.topic_memory = { ok: false, skipped: true, reason: "contact_unavailable" };
      }
    }

    const serviceDebug = result.debug as Record<string, unknown> | undefined;
    const llmCalls = mergeRuntimeLlmCallDebug(turnLlmCalls, serviceDebug?.llm_calls);

    const debugPayload = deps.debugEnabled
      ? { ...(result.debug ?? {}), ...memoryDebug, llm_calls: llmCalls, persistence_debug: persistenceDebug, runtime_context: runtimeContextDebug, case_context: caseContextDebug, runtime_gate: runtimeGateDebug, turn_understanding: turnUnderstandingDebug, topic_memory_candidate: topicMemoryCandidateDebug, reply_context_builder: replyContextBuilderDebug, legacy_case_router: caseRouterDebug }
      : undefined;

    const sideEffects: unknown[] = [];
    const actionTruth = buildBookingApplyActionTruth(result.tool_results);

    // Deterministic: inject contact-request UI for Telegram when phone is required.
    const telegramContactUi =
      actionTruth?.required_next_action === "ask_for_phone" &&
      runtimeTurnInput.business_context.channel === "telegram"
        ? { telegram: { request_contact: true as const, button_text: "📞 Поделиться контактом" } }
        : undefined;
    const rawMergedUi =
      telegramContactUi !== undefined || result.ui !== undefined
        ? { ...(result.ui ?? {}), ...(telegramContactUi ?? {}) }
        : undefined;

    // Suppress contact button if a trusted phone is already captured for this contact.
    const hasTrustedPhone =
      runtimeTurnInput.channel_contact !== undefined &&
      runtimeTurnInput.channel_contact !== null &&
      runtimeTurnInput.channel_contact.phone_source !== "manual_input";
    const mergedUi =
      hasTrustedPhone && rawMergedUi?.telegram?.request_contact === true
        ? { ...rawMergedUi, telegram: { ...rawMergedUi.telegram, request_contact: false as const } }
        : rawMergedUi;

    if (deps.adminNotifier) {
      const notifyReason = resolveAdminNotifyReason(actionTruth);
      if (notifyReason) {
        const bookingRequest = result.tool_requests.find((r) => r.tool === "booking.apply");
        const notificationPayload: AdminNotificationPayload = {
          clinic_id: runtimeTurnInput.clinic_id,
          clinic_code: clinicCode ?? null,
          channel: runtimeTurnInput.business_context.channel,
          chat_id: runtimeTurnInput.business_context.chat_id ?? null,
          external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
          trace_id: traceId,
          patient_display_name: readPatientDisplayName(validBody.meta),
          phone_source: runtimeTurnInput.channel_contact?.phone_source ?? null,
          phone_available: Boolean(runtimeTurnInput.channel_contact?.phone_number),
          original_message: runtimeTurnInput.user_message,
          requested_service: readStringArg(bookingRequest?.arguments, "service"),
          requested_date: readStringArg(bookingRequest?.arguments, "requested_date"),
          requested_time: readStringArg(bookingRequest?.arguments, "requested_time"),
          booking_status: actionTruth!.booking_status,
          created_visit: actionTruth!.created_visit,
          may_claim_booked: actionTruth!.may_claim_booked,
          required_next_action: actionTruth!.required_next_action,
          reason: notifyReason,
          timestamp: new Date().toISOString(),
        };
        const notificationResult = await deps.adminNotifier.notify(notificationPayload).catch((error) => ({
          type: "admin_notification" as const,
          status: "failed" as const,
          channel: "telegram" as const,
          reason: notifyReason,
          trace_id: traceId,
          error_code: error instanceof Error ? error.message : String(error),
        }));
        sideEffects.push(notificationResult);
      }
    }

    const responsePayload: RuntimeTurnHttpSuccessResponse = {
      trace_id: traceId,
      reply_text: result.final_patient_reply,
      final_patient_reply: result.final_patient_reply,
      side_effects: sideEffects,
      ...(mergedUi !== undefined ? { ui: mergedUi } : {}),
      ...(deps.debugEnabled ? {
        conversation_id: conversationIdToPersist,
        tool_results: result.tool_results,
        debug: debugPayload,
      } : {}),
    };
    void deps.runtimeTurnLogger?.logTurn({
      ts: new Date().toISOString(),
      status: "ok",
      trace_id: traceId,
      clinic_id: runtimeTurnInput.clinic_id,
      contact_id: canonicalContactId ?? "contact_unavailable",
      case_id: runtimeTurnInput.case_id,
      conversation_id: conversationIdToPersist,
      channel: runtimeTurnInput.business_context.channel,
      external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
      chat_id: runtimeTurnInput.business_context.chat_id ?? null,
      input_text: runtimeTurnInput.user_message,
      final_patient_reply: result.final_patient_reply,
      tool_results: result.tool_results,
      side_effects: responsePayload.side_effects,
      debug: responsePayload.debug,
      latency_ms: Date.now() - startTime,
    }).catch(() => undefined);

    return { outcome: "success", payload: responsePayload };
  } catch (error) {
    const runtimeError = error instanceof Error ? error.message : String(error);
    const fallbackPayload: RuntimeTurnHttpSuccessResponse = {
      trace_id: traceId,
      reply_text: RUNTIME_FALLBACK_REPLY,
      final_patient_reply: RUNTIME_FALLBACK_REPLY,
      side_effects: [
        {
          type: "admin_notification",
          channel: validBody.channel.trim(),
          reason: "runtime_turn_failed",
          payload: {
            trace_id: traceId,
            user_text: validBody.text.trim(),
            error_message: runtimeError,
          },
        },
      ],
      ...(deps.debugEnabled ? { debug: { runtime_error: runtimeError } } : {}),
    };
    void deps.runtimeTurnLogger?.logError({
      ts: new Date().toISOString(),
      status: "runtime_error",
      trace_id: traceId,
      error_code: "runtime_turn_failed",
      error_message: runtimeError,
      channel: runtimeTurnInput.business_context.channel,
      external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
      chat_id: runtimeTurnInput.business_context.chat_id ?? null,
      input_text: runtimeTurnInput.user_message,
      fallback_reply: fallbackPayload.final_patient_reply,
      side_effects: fallbackPayload.side_effects,
      latency_ms: Date.now() - startTime,
    }).catch(() => undefined);
    return { outcome: "error", fallbackPayload };
  }
}

// ── helpers (duplicated from runtimeTurnHttpRoute to keep module boundaries) ──

function mergeCaseContextIntoModelContext(baseContext: Record<string, unknown>, caseContext: unknown): Record<string, unknown> {
  const root = asRecord(caseContext);
  if (!Object.keys(root).length) return baseContext;
  const openCases = Array.isArray(root.open_cases) ? root.open_cases.map(asRecord) : [];
  const recentCases = Array.isArray(root.recent_cases) ? root.recent_cases.map(asRecord) : [];
  const appointmentContext = asRecord(root.active_booking_context);
  const activeHold = asRecord(appointmentContext.active_hold);
  const latestAppointment = asRecord(appointmentContext.latest_appointment);
  const currentCaseId = asString(root.current_case_id);
  const currentCase = openCases.find((openCase) => asString(openCase.case_id) === currentCaseId) ?? null;
  return {
    ...baseContext,
    case_context: {
      has_current_case: currentCaseId !== null,
      current_case: currentCase ? { case_type: asString(currentCase.case_type), topic: asString(currentCase.topic), status: asString(currentCase.status), priority: asString(currentCase.priority) } : null,
      open_cases_count: openCases.length,
      recent_cases: recentCases.map((row) => ({ case_type: asString(row.case_type), topic: asString(row.topic), status: asString(row.status) })),
    },
    booking_context: {
      has_active_hold: Object.keys(activeHold).length > 0,
      active_hold: Object.keys(activeHold).length > 0 ? { service_interest: asString(activeHold.service_interest), label: asString(activeHold.label), status: asString(activeHold.status) } : null,
      latest_appointment: Object.keys(latestAppointment).length > 0 ? { service_interest: asString(latestAppointment.service_interest), status: asString(latestAppointment.status), start_at: asString(latestAppointment.start_at) } : null,
    },
  };
}

function applyMessengerPhonePolicy(baseContext: Record<string, unknown>): Record<string, unknown> {
  const taskState = asRecord(baseContext.task_state);
  const runtimePolicy = asRecord(baseContext.runtime_policy);
  const missingFields = Array.isArray(taskState.missing_fields)
    ? taskState.missing_fields.filter((field): field is string => typeof field === "string" && field !== "phone")
    : [];
  return {
    ...baseContext,
    task_state: { ...taskState, missing_fields: missingFields },
    runtime_policy: { ...runtimePolicy, phone_required: false },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
  return trimmed ? trimmed : null;
}

function readPatientDisplayName(meta: Record<string, unknown> | undefined): string | null {
  const firstName = typeof meta?.first_name === "string" ? meta.first_name.trim() : "";
  const lastName = typeof meta?.last_name === "string" ? meta.last_name.trim() : "";
  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return combined.length > 0 ? combined : null;
}

function readStringArg(args: Record<string, unknown> | undefined, key: string): string | null {
  const value = args?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
