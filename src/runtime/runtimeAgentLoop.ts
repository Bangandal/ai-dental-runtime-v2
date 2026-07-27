import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  buildRuntimeAgentSystemInstruction,
  type AgentUiActions,
  type BookingApplyResolution,
  type OpenAIRuntimeAgent,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
  type RuntimeAgentTurnInput,
  type RuntimeAgentTurnResult,
} from "./openaiRuntimeAgent.ts";
import { resolveBookingExecutionSubject } from "./bookingSubjectExecutionResolver.ts";
import { bootstrapRegistryFromBookingApplyArgs, parseSubjectTarget } from "./bookingSubjectsState.ts";
import type { SubjectId, BookingSubjectsState } from "./bookingSubjectsState.ts";
import { applyToolPolicy, type PlannerOutput, type ToolName, type TruthSnapshot } from "./toolPolicy.ts";
import { executeAllowedTools, type ToolExecutorRegistry, type ToolExecutionContext } from "./toolExecutor.ts";
import { buildTruthSnapshot } from "./truthSnapshot.ts";
import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import type { ToolExecutionResult } from "./toolResults.ts";
import { buildModelVisibleCallerContext } from "./modelVisibleCallerContext.ts";
import { buildRuntimeLlmCallDebug } from "./llmCallDebug.ts";
import { buildBookingApplyActionTruth, buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";
import { buildCallerExceptionDiagnostics, sanitizeErrorMessage } from "./callerExceptionDiagnostics.ts";
import { hasTrustedPhone, hasBookingContactPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";
import { shouldInterceptMissingPhoneBeforeBookingApply, shouldInterceptNoSlotsBeforeBookingApply, bookingApplyArgsMissingSlot, getMissingBookingApplyNameFields, bookingApplyArgsMissingService, shouldInterceptInvalidSlotDateTime, shouldInterceptMissingSlotProof } from "./bookingApplyPreflight.ts";
import { isPastBookingTime, buildPastTimeReply, getTodayInTimezone } from "./bookingPreflight.ts";
import { buildAvailabilityPresentationTruth } from "./availabilityPresentationTruth.ts";
import { buildAvailabilityActionTruth, resolveAuthoritativeAvailabilityAttempt, findLastAvailabilityRequest } from "./availabilityActionTruth.ts";
import { buildAppointmentDisplayTruth } from "./appointmentDisplayTruth.ts";
import {
  computeBookingProcessState,
  buildModelVisibleBookingProcessState,
  hasMeaningfulBookingState,
  type BookingProcessStateRepository,
  type BookingProcessState,
  type ModelVisibleBookingProcessState,
} from "./bookingProcessState.ts";
import { executeBookingSelectSlot, type BookingSelectSlotSuccessData } from "./bookingSelectSlot.ts";
import { buildPhoneCaptureUi, sanitizePhoneCaptureUiForChannel } from "./channelCapabilityPolicy.ts";

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

export interface CreateRuntimeAgentLoopDeps {
  model: string;
  caller: RuntimeAgentCaller;
  executors: ToolExecutorRegistry;
  conversationMemoryRepository?: ConversationMemoryRepository;
  bookingProcessStateRepository?: BookingProcessStateRepository;
  now?: Date;
  timezone?: string;
}

const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);

export function createRuntimeAgentLoop(deps: CreateRuntimeAgentLoopDeps): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput): Promise<RuntimeAgentTurnResult> {
      // Per-turn clock: always a real Date so past-time guards and system instruction
      // are correct even when the caller does not inject deps.now (production).
      // Must be created here, not at loop-construction time, to avoid freezing time.
      const turnNow = deps.now ?? new Date();
      const timezone = deps.timezone ?? "Europe/Prague";

      const debug: Record<string, unknown> = { llm_calls: buildRuntimeLlmCallDebug() };
      const systemInstruction = buildRuntimeAgentSystemInstruction({
        now: turnNow,
        timezone,
        is_new_conversation: input.is_first_patient_turn ?? false,
      });
      let conversationId = input.conversation_id ?? null;

      if (!conversationId && deps.conversationMemoryRepository) {
        try {
          const memoryResult = await deps.conversationMemoryRepository.getConversationMemory({
            clinic_id: input.clinic_id,
            contact_id: input.contact_id,
            case_id: input.case_id,
          });
          debug.memory_loaded = memoryResult.ok;
          if (memoryResult.ok) {
            conversationId = memoryResult.data.conversation_id;
          } else {
            debug.memory_load_error = memoryResult.error;
          }
        } catch (error) {
          debug.memory_loaded = false;
          debug.memory_load_error = error instanceof Error ? error.message : String(error);
        }
      }

      const callerContext = buildModelVisibleCallerContext(input);

      // Load prior booking process state; compute initial per-turn state from it.
      let priorProcessState: Partial<BookingProcessState> | null = null;
      if (deps.bookingProcessStateRepository) {
        try {
          priorProcessState = await deps.bookingProcessStateRepository.loadState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            (info) => { debug.booking_process_state = info; },
          );
        } catch (err) {
          debug.booking_process_state = {
            loaded: false,
            reason: "rpc_error",
            error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          };
        }
      }

      // Initial state derived from prior state (no tool results yet this turn)
      let bookingProcessState = computeBookingProcessState({
        prior: priorProcessState,
        channelContact: input.channel_contact,
      });

      // First call: grounded only if prior state has meaningful booking data.
      // Non-booking tool results and empty prior state do NOT make it grounded.
      const firstCallGrounded =
        priorProcessState !== null && hasMeaningfulBookingState(priorProcessState);
      const firstCallVisibleState = buildModelVisibleBookingProcessState({
        state: bookingProcessState,
        priorProcessState,
        bookingStateGrounded: firstCallGrounded,
      });

      let firstOutput: RuntimeAgentCallerOutput;
      try {
        debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
        firstOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: { ...callerContext, booking_process_state: firstCallVisibleState },
            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
          },
        });
      } catch (error) {
        debug.runtime_error = {
          code: "agent_caller_failed",
          message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        };
        debug.reason = "agent_first_call_exception";
        debug.caller_exception = buildCallerExceptionDiagnostics(error, {
          stage: "first_call",
          locale: input.locale,
          conversationId,
        });
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMalformedResponseFallback(input.locale),
          conversation_id: conversationId,
          // Malformed/unparseable first response leaves OpenAI conversation in unknown state.
          // Mark dirty so orchestrator clears it rather than resuming on the next turn.
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      if (firstOutput.conversation_id !== undefined) {
        conversationId = firstOutput.conversation_id;
      }

      if (firstOutput.type === "final_response" && isMalformedFinalResponse(firstOutput)) {
        debug.reason = "malformed_first_model_response";
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMalformedResponseFallback(input.locale),
          conversation_id: conversationId,
          // Malformed output means OpenAI conversation state is unreliable — dirty it.
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      if (firstOutput.type === "final_response") {
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        // Persist state on no-tool final_response: saves any state change this turn
        // (selected_slot, phone_trusted, next_action, etc.) not just slot detection.
        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }
        return {
          final_patient_reply: firstOutput.final_response.final_patient_reply,
          conversation_id: conversationId,
          tool_requests: [],
          tool_results: [],
          debug,
          ui: maybeAttachPhoneRequestUI(firstCallVisibleState, firstOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
          ...(firstOutput.final_response.subject_intent != null ? { subject_intent: firstOutput.final_response.subject_intent } : {}),
          ...(firstOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: firstOutput.final_response.phone_ownership_intent } : {}),
        };
      }

      const toolRequests = firstOutput.tool_requests;
      // Accumulates all booking.apply requests seen this turn (round-1 + round-2),
      // so callers/orchestrators can see the full picture regardless of which round executed.
      const processedToolRequests: RuntimeAgentToolRequest[] = [...toolRequests];
      const toolResults: RuntimeAgentToolResult[] = [];

      // One booking write per turn — block all immediately if round-1 contains more than one.
      const allBookingApplyRound1 = toolRequests.filter((r) => r.tool === "booking.apply");
      if (allBookingApplyRound1.length > 1) {
        debug.reason = "booking_apply_preflight_multiple_booking_apply_round1";
        return await finalizeBlockedMultipleBookingApplies({
          pendingRequestsForRound: toolRequests,  // ALL round-1 requests must get results
          guardedData: {
            booking_status: "subject_resolution_conflict",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "clarify_subject",
            reason: "multiple_booking_apply_requests",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          booking_subjects_after_resolution: null,
        });
      }

      // Debug: log tool call args for observability (date/time/service only; name/phone redacted).
      debug.tool_call_args = toolRequests.map((r) => {
        const args = r.arguments ?? {};
        if (r.tool === "availability.check") {
          return {
            tool: r.tool,
            requested_date: args.requested_date ?? null,
            requested_time: args.requested_time ?? null,
            service_interest: args.service_interest ?? null,
          };
        }
        if (r.tool === "booking.apply") {
          return {
            tool: r.tool,
            requested_date: args.requested_date ?? null,
            requested_time: args.requested_time ?? null,
            service: args.service ?? null,
            // first_name/last_name deliberately omitted — patient PII
          };
        }
        return { tool: r.tool };
      });

      // Global preflight C — availability past-time guard: if availability.check is
      // requested for today at a time that has already passed, return the past-time reply
      // directly.  Without this, the executor filters the slot (0 slots returned) and the
      // model replies "нет свободных слотов" instead of "this time has passed".
      // Only fires when requested_time is explicitly present — missing time means "show all
      // slots for the day", which the executor handles correctly via past-slot filtering.
      const availCheckRound1 = findLastAvailabilityRequest(toolRequests);
      if (availCheckRound1) {
        const availTime = typeof availCheckRound1.arguments.requested_time === "string"
          ? availCheckRound1.arguments.requested_time : undefined;
        if (availTime && isPastBookingTime({
          requestedDate: typeof availCheckRound1.arguments.requested_date === "string"
            ? availCheckRound1.arguments.requested_date : undefined,
          requestedTime: availTime,
          timezone,
          now: turnNow,
        })) {
          debug.past_time_detail = {
            requestedDate: typeof availCheckRound1.arguments.requested_date === "string" ? availCheckRound1.arguments.requested_date : undefined,
            requestedTime: availTime,
            timezone,
            nowISO: turnNow.toISOString(),
            todayInTimezone: getTodayInTimezone(turnNow, timezone),
          };
          debug.reason = "availability_preflight_past_time";
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: buildPastTimeReply(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: toolRequests,
            tool_results: [],
            debug,
          };
        }
      }

      // Global preflight A — past-time guard: if booking.apply is requested for a
      // same-day slot that has already passed, reject before executing any tool.
      // Applies to round 1 (booking.apply as the first tool of a turn).
      const bookingApplyRound1 = toolRequests.find((r) => r.tool === "booking.apply");

      // Bootstrap registry: when model targets subject_2+ but no registry exists yet,
      // create a minimal multi-subject registry so subject-aware guards can resolve
      // execution subject. Returns null for subject_1 (single-subject flow — no registry).
      let effectiveBookingSubjects: BookingSubjectsState | null = input.booking_subjects ?? null;
      if (!effectiveBookingSubjects && bookingApplyRound1) {
        const bootstrapped = bootstrapRegistryFromBookingApplyArgs(
          bookingApplyRound1.arguments,
          input.channel_contact ?? null,
          input.current_turn_typed_phone ?? null,
        );
        if (bootstrapped) {
          effectiveBookingSubjects = bootstrapped;
        }
      }
      let effectiveInput: RuntimeAgentTurnInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
        ? { ...input, booking_subjects: effectiveBookingSubjects }
        : input;
      // Non-null when bootstrap created a new registry this turn; orchestrator persists it.
      // Updated again in round-2 if round-2 bootstrap creates a registry.
      let bootstrappedRegistry: BookingSubjectsState | null =
        effectiveInput !== input ? effectiveBookingSubjects : null;

      // Guard S (round 1) — same-round booking.select_slot + booking.apply:
      // Process select_slot deterministically, revoke old proof, persist state, and
      // close the booking.apply call ID with a blocked result.  ALL round-1 call IDs
      // are populated in toolResults so the second model call receives a complete
      // response.  The second call may issue booking.apply in round-2, which flows
      // through the normal round-2 guards and may execute via the executor.
      const round1SelectSlotRequests = toolRequests.filter((r) => r.tool === "booking.select_slot");
      const round1HasSelectSlot = round1SelectSlotRequests.length > 0;
      let guardSFired = false;

      if (round1HasSelectSlot && bookingApplyRound1) {
        const srAmbiguous = round1SelectSlotRequests.length > 1;
        let srSuccessData: BookingSelectSlotSuccessData | null = null;

        for (const req of round1SelectSlotRequests) {
          if (srAmbiguous) {
            toolResults.push({
              tool: "booking.select_slot",
              call_id: req.call_id,
              status: "failed",
              error: { code: "ambiguous_selection", message: "ambiguous_selection" },
            });
          } else {
            const selectResult = executeBookingSelectSlot(
              req.arguments,
              priorProcessState?.active_availability_evidence ?? null,
              effectiveBookingSubjects?.subjects ?? null,
            );
            if (selectResult.ok) {
              srSuccessData = selectResult.data;
              toolResults.push({
                tool: "booking.select_slot",
                call_id: req.call_id,
                status: "success",
                data: selectResult.data,
              });
            } else {
              toolResults.push({
                tool: "booking.select_slot",
                call_id: req.call_id,
                status: "failed",
                error: { code: selectResult.reason, message: selectResult.reason },
              });
            }
          }
        }

        // Close the same-round booking.apply call ID with a blocked result.
        toolResults.push({
          tool: "booking.apply",
          call_id: bookingApplyRound1.call_id,
          status: "success",
          data: {
            booking_status: "slot_not_verified",
            created_visit: false as const,
            may_claim_booked: false as const,
            required_next_action: "retry_booking_apply",
            reason: "select_slot_and_booking_apply_same_round",
          },
        });

        // Close any remaining round-1 call IDs (kb.search, availability.check, etc.) that
        // were not handled above.  OpenAI requires every function call to have a matching
        // tool result; skipping them via the normal tool loop would leave them open.
        const srHandledCallIds = new Set([
          ...round1SelectSlotRequests.map((r) => r.call_id),
          bookingApplyRound1.call_id,
        ]);
        for (const req of toolRequests) {
          if (!srHandledCallIds.has(req.call_id)) {
            toolResults.push({
              tool: req.tool,
              call_id: req.call_id,
              status: "denied",
              error: {
                code: "guard_s_same_round_protocol",
                message: "Tool was not executed because booking.select_slot and booking.apply were returned in the same round",
              },
            });
          }
        }

        // Revoke old proof (selectSlotAttemptedThisTurn=true); install new if selection succeeded.
        bookingProcessState = computeBookingProcessState({
          prior: priorProcessState,
          channelContact: input.channel_contact,
          selectSlotData: srSuccessData,
          selectSlotAttemptedThisTurn: true,
        });

        // Persist updated state (best-effort — non-blocking).
        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }

        debug.reason = "booking_apply_preflight_select_slot_same_round";
        guardSFired = true;
      }

      // Guard J (round 1) — FIRST: subject_id must be valid (subject_1..subject_4) for ALL
      // booking.apply calls. Resolve/freeze execution subject before ANY other booking guards fire.
      let round1ExecutionSubjectId: SubjectId | null = null;
      if (!guardSFired && bookingApplyRound1) {
        const subjectParse1 = parseSubjectTarget(bookingApplyRound1.arguments.subject_id);
        if (!subjectParse1.ok) {
          debug.reason = "booking_apply_preflight_subject_id_invalid_round1";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: subjectParse1.reason,
            },
            previousToolResults: [],
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }
        if (effectiveBookingSubjects) {
          const round1Resolution = resolveBookingExecutionSubject(
            effectiveBookingSubjects,
            bookingApplyRound1.arguments,
          );
          if (!round1Resolution.ok) {
            debug.reason = "booking_apply_preflight_subject_resolution_conflict_round1";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply: bookingApplyRound1,
              guardedData: {
                booking_status: "subject_resolution_conflict",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "clarify_subject",
                reason: round1Resolution.reason,
              },
              previousToolResults: [],
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }
          round1ExecutionSubjectId = round1Resolution.execution_subject_id;
        } else {
          // No registry: freeze to validated subject_id (subject_1 for self-booking)
          round1ExecutionSubjectId = subjectParse1.subject_id;
        }
      }

      // Guard I (round 1) — pending typed phone: fires right after subject resolution, before
      // slot guards. Subject is frozen; phone ownership must be resolved before execution.
      if (!guardSFired && bookingApplyRound1 && effectiveBookingSubjects?.pending_typed_phone) {
        debug.reason = "booking_apply_preflight_pending_typed_phone_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "pending_phone_classification",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "none",
            reason: "typed_phone_subject_unclear",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          execution_subject_id: round1ExecutionSubjectId,
          booking_subjects_after_resolution: bootstrappedRegistry,
        });
      }

      // Global preflight A — past-time guard (round 1): fires after subject resolution.
      if (!guardSFired && bookingApplyRound1) {
        if (isPastBookingTime({
          requestedDate: typeof bookingApplyRound1.arguments.requested_date === "string"
            ? bookingApplyRound1.arguments.requested_date : undefined,
          requestedTime: typeof bookingApplyRound1.arguments.requested_time === "string"
            ? bookingApplyRound1.arguments.requested_time : undefined,
          timezone,
          now: turnNow,
        })) {
          debug.past_time_detail = {
            requestedDate: typeof bookingApplyRound1.arguments.requested_date === "string" ? bookingApplyRound1.arguments.requested_date : undefined,
            requestedTime: typeof bookingApplyRound1.arguments.requested_time === "string" ? bookingApplyRound1.arguments.requested_time : undefined,
            timezone,
            nowISO: turnNow.toISOString(),
            todayInTimezone: getTodayInTimezone(turnNow, timezone),
          };
          debug.reason = "booking_apply_preflight_past_time_round1";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "past_time",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_alternative_time",
              reason: "requested_time_is_in_past",
            },
            previousToolResults: [],
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            execution_subject_id: round1ExecutionSubjectId,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }
      }

      // Global preflight D — no-slot guard (round 1): fires after subject resolution.
      if (!guardSFired && bookingApplyRound1 && bookingApplyArgsMissingSlot(bookingApplyRound1.arguments)) {
        debug.reason = "booking_apply_preflight_missing_slot_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_slot",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_slot",
            reason: "requested_date_time_required",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          execution_subject_id: round1ExecutionSubjectId,
          booking_subjects_after_resolution: bootstrappedRegistry,
        });
      }

      // Global preflight G — slot proof guard (round 1): fires after subject resolution.
      if (!guardSFired && bookingApplyRound1 && shouldInterceptMissingSlotProof({
        pendingToolRequests: toolRequests,
        activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
        selectedSlot: bookingProcessState.selected_slot,
        selectedSlotProof: bookingProcessState.selected_slot_proof,
      })) {
        debug.reason = "booking_apply_preflight_missing_slot_proof_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "slot_not_verified",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_slot",
            reason: "slot_proof_required",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          execution_subject_id: round1ExecutionSubjectId,
          booking_subjects_after_resolution: bootstrappedRegistry,
        });
      }

      // Global preflight B — phone guard (round 1): fires after slot guards.
      if (!guardSFired && bookingApplyRound1 && !hasSubjectOrContactPhone(effectiveInput, round1ExecutionSubjectId)) {
        debug.reason = "booking_apply_preflight_missing_trusted_phone_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_trusted_phone",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_phone",
            reason: "trusted_phone_required",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          execution_subject_id: round1ExecutionSubjectId,
          booking_subjects_after_resolution: bootstrappedRegistry,
        });
      }

      // Global preflight E — name-missing guard (round 1).
      if (!guardSFired && bookingApplyRound1 && hasSubjectOrContactPhone(effectiveInput, round1ExecutionSubjectId)) {
        const missingNames = getMissingBookingApplyNameFields(bookingApplyRound1.arguments);
        if (missingNames.length > 0) {
          debug.reason = "booking_apply_preflight_missing_name_round1";
          debug.missing_fields = missingNames;
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "missing_patient_name",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_name",
              reason: "patient_name_required",
              missing_fields: missingNames,
            },
            previousToolResults: [],
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            execution_subject_id: round1ExecutionSubjectId,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }
      }

      // Global preflight F — service-missing guard (round 1).
      if (!guardSFired && bookingApplyRound1 && hasSubjectOrContactPhone(effectiveInput, round1ExecutionSubjectId) && bookingApplyArgsMissingService(bookingApplyRound1.arguments)) {
        debug.reason = "booking_apply_preflight_missing_service_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_service",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_service",
            reason: "service_required",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          execution_subject_id: round1ExecutionSubjectId,
          booking_subjects_after_resolution: bootstrappedRegistry,
        });
      }

      // When Guard S fired, booking.apply was blocked in round-1 (not executed) — no resolution.
      let round1BookingApplyResolution: BookingApplyResolution | null = null;
      if (!guardSFired && bookingApplyRound1 && round1ExecutionSubjectId) {
        round1BookingApplyResolution = {
          call_id: bookingApplyRound1.call_id,
          subject_id: round1ExecutionSubjectId,
        };
      }

      // Normal tool loop: skip when Guard S has already handled round-1 tools.
      if (!guardSFired) {
        // Track the first successful booking.select_slot result this turn.
        let selectSlotSuccessData: BookingSelectSlotSuccessData | null = null;
        // Multiple booking.select_slot calls in one round → ambiguous → no proof created.
        const selectSlotRequestCount = toolRequests.filter((r) => r.tool === "booking.select_slot").length;
        const selectSlotAmbiguous = selectSlotRequestCount > 1;

        for (const request of toolRequests) {
          if (!ACTIVE_TOOL_SET.has(request.tool)) {
            toolResults.push({
              tool: request.tool,
              call_id: request.call_id,
              status: "denied",
              error: { code: "tool_not_active", message: `${request.tool} is not active` },
            });
            continue;
          }

          if (request.tool === "booking.select_slot") {
            if (selectSlotAmbiguous) {
              toolResults.push({
                tool: "booking.select_slot",
                call_id: request.call_id,
                status: "failed",
                error: { code: "ambiguous_selection", message: "ambiguous_selection" },
              });
              continue;
            }
            const selectResult = executeBookingSelectSlot(
              request.arguments,
              priorProcessState?.active_availability_evidence ?? null,
              effectiveBookingSubjects?.subjects ?? null,
            );
            if (selectResult.ok) {
              selectSlotSuccessData = selectResult.data;
              toolResults.push({
                tool: "booking.select_slot",
                call_id: request.call_id,
                status: "success",
                data: selectResult.data,
              });
            } else {
              toolResults.push({
                tool: "booking.select_slot",
                call_id: request.call_id,
                status: "failed",
                error: { code: selectResult.reason, message: selectResult.reason },
              });
            }
            continue;
          }

          const planner = buildPlannerFromAgentToolRequest(request);
          const truth = resolveTruthSnapshot(input, request, planner, turnNow);
          const policy = applyToolPolicy(planner, truth);
          if (policy.tools_denied.length > 0 || policy.tools_allowed.length === 0) {
            const denial = policy.tools_denied[0];
            toolResults.push({
              tool: request.tool,
              call_id: request.call_id,
              status: "denied",
              error: {
                code: denial?.reason ?? "policy_denied",
                message: `Tool denied by policy: ${denial?.reason ?? "unknown"}`,
              },
            });
            continue;
          }

          const executionContext = buildExecutionContext(
            request.tool === "booking.apply" ? effectiveInput : input,
            request,
            planner,
            truth,
            turnNow,
            request.tool === "booking.apply" ? round1ExecutionSubjectId : null,
          );
          const executionResults = await executeAllowedTools({
            tools_allowed: policy.tools_allowed,
            registry: deps.executors,
            context: executionContext,
          });
          const execResult = executionResults[0];
          if (execResult?.tool === "availability.check" && execResult.status === "success" && execResult._diagnostic !== undefined) {
            debug.availability_diagnostic = execResult._diagnostic;
          }
          toolResults.push(convertToolExecutionResult(request, execResult));
        }

        // Update booking process state with tool results from this round.
        const authAvailAttemptNormal = resolveAuthoritativeAvailabilityAttempt(processedToolRequests, toolResults);
        bookingProcessState = computeBookingProcessState({
          prior: priorProcessState,
          authoritativeAvailabilityAttempt: authAvailAttemptNormal,
          channelContact: input.channel_contact,
          selectSlotData: selectSlotSuccessData,
          // Any select_slot attempt (success or failure) revokes the prior proof.
          selectSlotAttemptedThisTurn: selectSlotRequestCount > 0,
        });
        // Persist updated state (best-effort — non-blocking).
        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }
      }  // end if (!guardSFired) normal tool loop

      const bookingActionTruth = buildBookingApplyActionTruth(toolResults);
      // Resolve the authoritative availability attempt once; pass to all three consumers
      // so action truth, presentation truth, and booking state share the same pair.
      const authoritativeAvailabilityAttempt = resolveAuthoritativeAvailabilityAttempt(processedToolRequests, toolResults);
      const availabilityActionTruth = buildAvailabilityActionTruth(authoritativeAvailabilityAttempt);
      const availabilityPresentationTruth = buildAvailabilityPresentationTruth(authoritativeAvailabilityAttempt);
      const appointmentDisplayTruth = buildAppointmentDisplayTruth(toolResults);

      // Second call: grounded when prior state had meaningful booking data, OR
      // when the current turn produced booking-relevant evidence (availability.check /
      // booking.apply tool results, or selected_slot detected from offered slots).
      // Non-booking tools (knowledge.search, faq, etc.) do NOT make state grounded.
      const hasBookingToolResult = toolResults.some(
        (r) => r.tool === "availability.check" || r.tool === "booking.apply" || r.tool === "booking.select_slot",
      );
      const selectedSlotDetected = bookingProcessState.selected_slot != null;
      const secondCallGrounded =
        (priorProcessState !== null && hasMeaningfulBookingState(priorProcessState)) ||
        hasBookingToolResult ||
        selectedSlotDetected;
      const secondCallVisibleState = buildModelVisibleBookingProcessState({
        state: bookingProcessState,
        priorProcessState,
        bookingStateGrounded: secondCallGrounded,
      });

      const secondCallContext = {
        ...callerContext,
        ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
        ...(availabilityActionTruth ? { availability_action_truth: availabilityActionTruth } : {}),
        ...(availabilityPresentationTruth ? { availability_presentation_truth: availabilityPresentationTruth } : {}),
        ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
        booking_process_state: secondCallVisibleState,
      };

      let secondOutput: RuntimeAgentCallerOutput;
      try {
        secondOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: secondCallContext,
            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
            tool_results: toolResults,
          },
        });
      } catch (error) {
        debug.runtime_error = {
          code: "agent_final_response_failed",
          message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        };
        const emergencyReply = bookingActionTruth
          ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
          : buildMalformedResponseFallback(input.locale);
        debug.reason = bookingActionTruth
          ? "agent_second_call_exception_booking_fallback"
          : "agent_second_call_exception_generic_fallback";
        debug.caller_exception = buildCallerExceptionDiagnostics(error, {
          stage: "second_call",
          locale: input.locale,
          conversationId,
          toolResults,
          bookingApplyActionTruth: bookingActionTruth,
        });
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: emergencyReply,
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
          // Preserve execution metadata so orchestrator can persist booking result even on exception
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      if (secondOutput.conversation_id !== undefined) {
        conversationId = secondOutput.conversation_id;
      }

      if (secondOutput.type === "final_response" && isMalformedFinalResponse(secondOutput)) {
        const malformedReply = bookingActionTruth
          ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
          : buildMalformedResponseFallback(input.locale);
        debug.reason = bookingActionTruth
          ? "malformed_second_model_response_booking_fallback"
          : "malformed_second_model_response_generic_fallback";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: malformedReply,
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
          // Preserve execution metadata even on malformed response
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      if (secondOutput.type === "tool_requests") {
        // Debug: append round-2 tool args (same PII-safe pattern as round 1).
        if (Array.isArray(debug.tool_call_args)) {
          const round2Args = secondOutput.tool_requests.map((r) => {
            const args = r.arguments ?? {};
            if (r.tool === "availability.check") {
              return {
                tool: r.tool,
                requested_date: args.requested_date ?? null,
                requested_time: args.requested_time ?? null,
                service_interest: args.service_interest ?? null,
              };
            }
            if (r.tool === "booking.apply") {
              return {
                tool: r.tool,
                requested_date: args.requested_date ?? null,
                requested_time: args.requested_time ?? null,
                service: args.service ?? null,
              };
            }
            return { tool: r.tool };
          });
          debug.tool_call_args = [...(debug.tool_call_args as unknown[]), ...round2Args];
        }

        // Round-2 guard order: find pendingBookingApply → push to processedToolRequests →
        // one-booking-per-turn check → Guard J (strict parse) → bootstrap → freeze subject →
        // no-slots → Guard I → past-time → slot guards → phone → name/service → execution.

        // 1. Add ALL round-2 requests to processedToolRequests (not just booking.apply).
        for (const req of secondOutput.tool_requests) processedToolRequests.push(req);

        const allRound2BookingRequests = secondOutput.tool_requests.filter((r) => r.tool === "booking.apply");
        const pendingBookingApply = allRound2BookingRequests[0] ?? null;

        // 2a. Round-2 multiple: more than one booking.apply — block ALL calls from this round.
        if (allRound2BookingRequests.length > 1) {
          debug.reason = "booking_apply_preflight_multiple_booking_apply_round2_multi";
          return await finalizeBlockedMultipleBookingApplies({
            pendingRequestsForRound: secondOutput.tool_requests,  // ALL requests get results
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: "multiple_booking_apply_requests",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_apply_resolution: round1BookingApplyResolution,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }

        // 2b. One booking write per turn: if round-1 already executed booking.apply,
        //     block any round-2 booking.apply and preserve round-1 resolution.
        //     Skip when Guard S fired — Guard S's blocked result in toolResults must NOT prevent
        //     the legitimate round-2 booking.apply from reaching the executor.
        if (!guardSFired && pendingBookingApply && toolResults.some((r) => r.tool === "booking.apply")) {
          debug.reason = "booking_apply_preflight_multiple_booking_apply_round2";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply,
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: "multiple_booking_apply_requests",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_apply_resolution: round1BookingApplyResolution,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }

        // 2c. Round-2 booking.select_slot — explicitly rejected with deterministic failed results.
        // booking.select_slot is only valid in round-1; any round-2 occurrence is a protocol error.
        // A round-2 protocol error must not fall through to an old persisted proof — if booking.apply
        // is also present in this round, block it immediately rather than letting it use stale state.
        const round2SelectSlotRequests = secondOutput.tool_requests.filter((r) => r.tool === "booking.select_slot");
        if (round2SelectSlotRequests.length > 0) {
          for (const req of round2SelectSlotRequests) {
            toolResults.push({
              tool: "booking.select_slot",
              call_id: req.call_id,
              status: "failed",
              error: { code: "select_slot_not_allowed_in_round2", message: "select_slot_not_allowed_in_round2" },
            });
          }
          debug.reason = "booking_select_slot_rejected_in_round2";
          if (pendingBookingApply) {
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "slot_not_verified",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_slot",
                reason: "select_slot_rejected_in_round2",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_apply_resolution: round1BookingApplyResolution,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }
        }

        // 3. Guard J (round 2) — strict subject_id validation (subject_1..subject_4 only).
        let round2ExecutionSubjectId: SubjectId | null = null;
        if (pendingBookingApply) {
          const subjectParse2 = parseSubjectTarget(pendingBookingApply.arguments.subject_id);
          if (!subjectParse2.ok) {
            debug.reason = "booking_apply_preflight_subject_id_invalid_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "subject_resolution_conflict",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "clarify_subject",
                reason: subjectParse2.reason,
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          // 4. Round-2 bootstrap: when registry absent (e.g. round-1 was availability.check
          //    only) and booking.apply targets subject_2+, create the registry now.
          if (!effectiveBookingSubjects) {
            const r2Bootstrapped = bootstrapRegistryFromBookingApplyArgs(
              pendingBookingApply.arguments,
              input.channel_contact ?? null,
              input.current_turn_typed_phone ?? null,
            );
            if (r2Bootstrapped) {
              effectiveBookingSubjects = r2Bootstrapped;
              effectiveInput = { ...input, booking_subjects: effectiveBookingSubjects };
              bootstrappedRegistry = r2Bootstrapped;
            }
          }

          // 5. Freeze execution subject.
          if (effectiveBookingSubjects) {
            const round2Resolution = resolveBookingExecutionSubject(
              effectiveBookingSubjects,
              pendingBookingApply.arguments,
            );
            if (!round2Resolution.ok) {
              debug.reason = "booking_apply_preflight_subject_resolution_conflict_round2";
              return await finalizeBlockedBookingApplyWithToolOutput({
                pendingBookingApply,
                guardedData: {
                  booking_status: "subject_resolution_conflict",
                  created_visit: false,
                  may_claim_booked: false,
                  required_next_action: "clarify_subject",
                  reason: round2Resolution.reason,
                },
                previousToolResults: toolResults,
                toolRequests: processedToolRequests,
                conversationId,
                systemInstruction,
                callerContext,
                input,
                debug,
                deps,
                booking_subjects_after_resolution: bootstrappedRegistry,
              });
            }
            round2ExecutionSubjectId = round2Resolution.execution_subject_id;
          } else {
            // No registry: freeze to validated subject_id.
            round2ExecutionSubjectId = subjectParse2.subject_id;
          }
        }

        // 6. No-slots gate — fires AFTER Guard J, bootstrap, and execution subject freeze.
        //    availability.check returned 0 slots so there is nothing to confirm.
        if (shouldInterceptNoSlotsBeforeBookingApply({
          pendingToolRequests: secondOutput.tool_requests,
          completedToolResults: toolResults,
        })) {
          const noSlotsPendingApply = pendingBookingApply ?? secondOutput.tool_requests.find((r) => r.tool === "booking.apply")!;
          debug.reason = "booking_apply_preflight_no_slots";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: noSlotsPendingApply,
            guardedData: {
              booking_status: "no_available_slots",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_alternative_time",
              reason: "availability_check_returned_no_slots",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_subjects_after_resolution: bootstrappedRegistry,
            execution_subject_id: round2ExecutionSubjectId,
          });
        }

        if (pendingBookingApply) {
          // 7. Guard I (round 2): pending typed phone fires right after subject resolution,
          //    before slot guards — phone ownership must be resolved before execution.
          if (effectiveBookingSubjects?.pending_typed_phone) {
            debug.reason = "booking_apply_preflight_pending_typed_phone_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "pending_phone_classification",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "none",
                reason: "typed_phone_subject_unclear",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_subjects_after_resolution: bootstrappedRegistry,
              execution_subject_id: round2ExecutionSubjectId,
            });
          }

          // 8. Past-time preflight (round 2): fires after subject resolution.
          if (isPastBookingTime({
              requestedDate: typeof pendingBookingApply.arguments.requested_date === "string"
                ? pendingBookingApply.arguments.requested_date : undefined,
              requestedTime: typeof pendingBookingApply.arguments.requested_time === "string"
                ? pendingBookingApply.arguments.requested_time : undefined,
              timezone,
              now: turnNow,
            })) {
              debug.past_time_detail = {
                requestedDate: typeof pendingBookingApply.arguments.requested_date === "string" ? pendingBookingApply.arguments.requested_date : undefined,
                requestedTime: typeof pendingBookingApply.arguments.requested_time === "string" ? pendingBookingApply.arguments.requested_time : undefined,
                timezone,
                nowISO: turnNow.toISOString(),
                todayInTimezone: getTodayInTimezone(turnNow, timezone),
              };
              debug.reason = "booking_apply_preflight_past_time_round2";
              return await finalizeBlockedBookingApplyWithToolOutput({
                pendingBookingApply,
                guardedData: {
                  booking_status: "past_time",
                  created_visit: false,
                  may_claim_booked: false,
                  required_next_action: "ask_for_alternative_time",
                  reason: "requested_time_is_in_past",
                },
                previousToolResults: toolResults,
                toolRequests: processedToolRequests,
                conversationId,
                systemInstruction,
                callerContext,
                input,
                debug,
                deps,
                execution_subject_id: round2ExecutionSubjectId,
                booking_subjects_after_resolution: bootstrappedRegistry,
              });
          }

          // 9. Guard D (round 2): missing date+time — fires after subject resolution.
          if (bookingApplyArgsMissingSlot(pendingBookingApply.arguments)) {
            debug.reason = "booking_apply_preflight_missing_slot_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_slot",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_slot",
                reason: "requested_date_time_required",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              execution_subject_id: round2ExecutionSubjectId,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          // 10. Guard G (round 2): slot not verified — fires after subject resolution.
          if (shouldInterceptMissingSlotProof({
            pendingToolRequests: secondOutput.tool_requests,
            activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
            selectedSlot: bookingProcessState.selected_slot,
            selectedSlotProof: bookingProcessState.selected_slot_proof,
          })) {
            debug.reason = "booking_apply_preflight_missing_slot_proof_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "slot_not_verified",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_slot",
                reason: "slot_proof_required",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              execution_subject_id: round2ExecutionSubjectId,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          // 11. Guard H (round 2): invalid slot — fires after subject resolution.
          if (shouldInterceptInvalidSlotDateTime({
            pendingToolRequests: secondOutput.tool_requests,
            activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
            selectedSlot: bookingProcessState.selected_slot,
            selectedSlotProof: bookingProcessState.selected_slot_proof,
          })) {
            debug.reason = "booking_apply_preflight_invalid_slot_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "invalid_slot",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "choose_from_available_slots",
                reason: "requested_time_not_in_available_slots",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              execution_subject_id: round2ExecutionSubjectId,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }
        }

        // 12. Guard A: booking.apply requested in round-2 but trusted phone absent.
        //     Runs after slot guards so we don't ask for phone when slots are invalid.
        if (hasBookingApplyPending(secondOutput.tool_requests) && !hasSubjectOrContactPhone(effectiveInput, round2ExecutionSubjectId)) {
          const missingPhonePendingApply = pendingBookingApply ?? secondOutput.tool_requests.find((r) => r.tool === "booking.apply")!;
          debug.reason = "booking_apply_intercepted_missing_trusted_phone";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: missingPhonePendingApply,
            guardedData: {
              booking_status: "missing_trusted_phone",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_phone",
              reason: "trusted_phone_required",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            execution_subject_id: round2ExecutionSubjectId,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }

        // 13. Guard B: round-2 booking.apply with trusted phone — execute it.
        if (pendingBookingApply && hasSubjectOrContactPhone(effectiveInput, round2ExecutionSubjectId)) {
          // Guard E (round 2): slot and phone present but first_name or last_name absent.
          const round2MissingNames = getMissingBookingApplyNameFields(pendingBookingApply.arguments);
          if (round2MissingNames.length > 0) {
            debug.reason = "booking_apply_preflight_missing_name_round2";
            debug.missing_fields = round2MissingNames;
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_patient_name",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_name",
                reason: "patient_name_required",
                missing_fields: round2MissingNames,
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              execution_subject_id: round2ExecutionSubjectId,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          // Guard F (round 2): name and slot present but service/service_reason absent.
          if (bookingApplyArgsMissingService(pendingBookingApply.arguments)) {
            debug.reason = "booking_apply_preflight_missing_service_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_service",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_service",
                reason: "service_required",
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              execution_subject_id: round2ExecutionSubjectId,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          debug.reason = "booking_apply_executed_after_round2_request";
          const bPlanner = buildPlannerFromAgentToolRequest(pendingBookingApply);
          const bTruth = resolveTruthSnapshot(effectiveInput, pendingBookingApply, bPlanner, turnNow);
          const bPolicy = applyToolPolicy(bPlanner, bTruth);

          let bookingToolResult: RuntimeAgentToolResult;
          if (bPolicy.tools_denied.length > 0 || bPolicy.tools_allowed.length === 0) {
            const denial = bPolicy.tools_denied[0];
            bookingToolResult = {
              tool: "booking.apply",
              call_id: pendingBookingApply.call_id,
              status: "denied",
              error: {
                code: denial?.reason ?? "policy_denied",
                message: `Tool denied by policy: ${denial?.reason ?? "unknown"}`,
              },
            };
          } else {
            // Pass resolved execution subject so phone is drawn from the correct subject
            const bExecCtx = buildExecutionContext(effectiveInput, pendingBookingApply, bPlanner, bTruth, turnNow, round2ExecutionSubjectId);
            const bExecResults = await executeAllowedTools({
              tools_allowed: bPolicy.tools_allowed,
              registry: deps.executors,
              context: bExecCtx,
            });
            bookingToolResult = convertToolExecutionResult(pendingBookingApply, bExecResults[0]);
          }

          const allResults = [...toolResults, bookingToolResult];
          const bookingApplyTruth = buildBookingApplyActionTruth(allResults);
          const bookingApplyDisplayTruth = buildAppointmentDisplayTruth(allResults);

          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);

          let bookingFinalOutput: RuntimeAgentCallerOutput | undefined;
          try {
            bookingFinalOutput = await deps.caller({
              model: deps.model,
              conversation_id: null,
              system_instruction: systemInstruction,
              input: {
                message: input.user_message,
                context: {
                  ...callerContext,
                  resolved_context: allResults,
                  ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
                  ...(bookingApplyDisplayTruth ? { appointment_display_truth: bookingApplyDisplayTruth } : {}),
                },
              },
            });
          } catch (error) {
            debug.caller_exception = buildCallerExceptionDiagnostics(error, {
              stage: "forced_finalization",
              locale: input.locale,
              conversationId: null,
              toolResults: allResults,
              bookingApplyActionTruth: bookingApplyTruth,
            });
          }

          const round2BookingApplyResolution: BookingApplyResolution | null =
            pendingBookingApply && round2ExecutionSubjectId
              ? { call_id: pendingBookingApply.call_id, subject_id: round2ExecutionSubjectId }
              : null;

          if (bookingFinalOutput !== undefined && bookingFinalOutput.type === "final_response" && !isMalformedFinalResponse(bookingFinalOutput)) {
            return {
              final_patient_reply: bookingFinalOutput.final_response.final_patient_reply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: processedToolRequests,
              tool_results: allResults,
              debug,
              ui: sanitizePhoneCaptureUiForChannel(bookingFinalOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
              ...(bookingFinalOutput.final_response.subject_intent != null ? { subject_intent: bookingFinalOutput.final_response.subject_intent } : {}),
              ...(bookingFinalOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: bookingFinalOutput.final_response.phone_ownership_intent } : {}),
              ...(round2ExecutionSubjectId != null ? { execution_subject_id: round2ExecutionSubjectId } : {}),
              ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
              ...(round2BookingApplyResolution != null ? { booking_apply_resolution: round2BookingApplyResolution } : {}),
            };
          }

          const bFallback = bookingApplyTruth
            ? buildBookingApplyEmergencyFallback(allResults, input.locale)
            : buildMultiRoundFallbackReply(input.locale);
          return {
            final_patient_reply: bFallback,
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: processedToolRequests,
            tool_results: allResults,
            debug,
            ...(round2ExecutionSubjectId != null ? { execution_subject_id: round2ExecutionSubjectId } : {}),
            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
            ...(round2BookingApplyResolution != null ? { booking_apply_resolution: round2BookingApplyResolution } : {}),
          };
        }

        // When round 2 requests more tools but useful results from round 1 exist,
        // attempt one forced finalization call (round 3). Protocol rules:
        // - conversation_id is null: fresh context so we don't continue a thread
        //   that has round-2 tool calls pending (which we cannot resolve here).
        // - No tool_results: avoids sending function_call_output for round-1 call_ids
        //   into a conversation whose last model turn requested different call_ids.
        // - Tool results are embedded as resolved_context in plain JSON — readable by
        //   the model without requiring tool-call protocol mechanics.
        // - No tool_definitions: model cannot request tools and must produce final_response.
        // Bounded: max 3 LLM calls total. Does not implement a recursive loop.
        if (hasUsefulToolResults(toolResults)) {
          let forcedOutput: RuntimeAgentCallerOutput | undefined;
          try {
            forcedOutput = await deps.caller({
              model: deps.model,
              conversation_id: null,
              system_instruction: systemInstruction,
              input: {
                message: input.user_message,
                context: {
                  ...callerContext,
                  resolved_context: toolResults,
                  ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
                  ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
                },
                // No tool_definitions → caller sends tools:[] → model must produce final_response.
                // No tool_results → no function_call_output protocol messages.
              },
            });
          } catch (error) {
            // Forced finalization failed — fall through to locale-aware fallback.
            debug.caller_exception = buildCallerExceptionDiagnostics(error, {
              stage: "forced_finalization",
              locale: input.locale,
              conversationId,
              toolResults,
              bookingApplyActionTruth: bookingActionTruth,
            });
          }
          if (forcedOutput !== undefined && forcedOutput.type === "final_response" && isMalformedFinalResponse(forcedOutput)) {
            debug.reason = "malformed_forced_finalization_fallback";
            const malformedForcedReply = bookingActionTruth
              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
              : buildMultiRoundFallbackReply(input.locale);
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: malformedForcedReply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: processedToolRequests,
              tool_results: toolResults,
              debug,
              ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
              ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
              ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
            };
          }
          if (forcedOutput !== undefined && forcedOutput.type === "final_response") {
            debug.reason = "forced_finalization_after_tool_results";
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: forcedOutput.final_response.final_patient_reply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: processedToolRequests,
              tool_results: toolResults,
              debug,
              ui: sanitizePhoneCaptureUiForChannel(forcedOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
              ...(forcedOutput.final_response.subject_intent != null ? { subject_intent: forcedOutput.final_response.subject_intent } : {}),
              ...(forcedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: forcedOutput.final_response.phone_ownership_intent } : {}),
              ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
              ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
              ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
            };
          }
        }

        debug.reason = "multi_round_tool_loop_not_implemented";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: processedToolRequests,
          tool_results: toolResults,
          debug,
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
      return {
        final_patient_reply: secondOutput.final_response.final_patient_reply,
        conversation_id: conversationId,
        tool_requests: toolRequests,
        tool_results: toolResults,
        debug,
        ui: maybeAttachPhoneRequestUI(secondCallVisibleState, secondOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
        ...(secondOutput.final_response.subject_intent != null ? { subject_intent: secondOutput.final_response.subject_intent } : {}),
        ...(secondOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: secondOutput.final_response.phone_ownership_intent } : {}),
        // Propagate frozen execution subject so orchestrator can apply booking result to correct subject
        ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
        ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
        ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
      };
    },
  };
}

// ── Multiple-blocked booking.apply helper (Variant A) ────────────────────────

/**
 * When multiple booking.apply calls are present in the same round, create a
 * synthetic "blocked" result for EACH call_id and submit them all at once to
 * the model. This closes all pending function_calls cleanly so the conversation
 * stays resumable, and prevents any single call_id from being left dangling.
 */
export async function finalizeBlockedMultipleBookingApplies(params: {
  /** All pending requests from the current model response — every call_id must get a result. */
  pendingRequestsForRound: RuntimeAgentToolRequest[];
  guardedData: GuardedBookingApplyData;
  previousToolResults: RuntimeAgentToolResult[];
  toolRequests: RuntimeAgentToolRequest[];
  conversationId: string | null;
  systemInstruction: string;
  callerContext: Record<string, unknown>;
  input: RuntimeAgentTurnInput;
  debug: Record<string, unknown>;
  deps: CreateRuntimeAgentLoopDeps;
  booking_apply_resolution?: BookingApplyResolution | null;
  booking_subjects_after_resolution?: BookingSubjectsState | null;
}): Promise<RuntimeAgentTurnResult> {
  const {
    pendingRequestsForRound, guardedData, previousToolResults, toolRequests,
    conversationId, systemInstruction, callerContext, input, debug, deps,
    booking_apply_resolution, booking_subjects_after_resolution,
  } = params;

  // Create a result for each call_id — booking.apply gets the blocked data,
  // other tools get a denial explaining why they were not executed.
  const guardedResults: RuntimeAgentToolResult[] = pendingRequestsForRound.map((req) => {
    if (req.tool === "booking.apply") {
      return {
        tool: "booking.apply",
        call_id: req.call_id,
        status: "success" as const,
        data: guardedData,
      };
    }
    return {
      tool: req.tool,
      call_id: req.call_id,
      status: "denied" as const,
      error: {
        code: "turn_aborted_due_to_multiple_booking_requests",
        message: "Tool was not executed because multiple booking.apply requests were emitted.",
      },
    };
  });

  const allResults = [...previousToolResults, ...guardedResults];
  const bookingApplyTruth = buildBookingApplyActionTruth(allResults);

  let guardedOutput: RuntimeAgentCallerOutput;
  try {
    guardedOutput = await deps.caller({
      model: deps.model,
      conversation_id: conversationId,
      system_instruction: systemInstruction,
      input: {
        message: input.user_message,
        context: {
          ...callerContext,
          ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
        },
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
        tool_results: guardedResults,
      },
    });
  } catch (error) {
    debug.runtime_error = {
      code: "guarded_multiple_booking_caller_failed",
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    };
    debug.finalization_reason = "guarded_multiple_booking_caller_exception";
    debug.caller_exception = buildCallerExceptionDiagnostics(error, {
      stage: "second_call",
      locale: input.locale,
      conversationId,
      toolResults: allResults,
      bookingApplyActionTruth: bookingApplyTruth,
    });
    markConversationDirty(debug);
    await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
    return {
      final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
      conversation_id: null,
      conversation_id_resumable: false,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    };
  }

  let updatedConversationId = conversationId;
  if (guardedOutput.conversation_id !== undefined) {
    updatedConversationId = guardedOutput.conversation_id;
  }

  if (guardedOutput.type === "final_response" && !isMalformedFinalResponse(guardedOutput)) {
    await saveConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
    return {
      final_patient_reply: guardedOutput.final_response.final_patient_reply,
      conversation_id: updatedConversationId,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ui: sanitizePhoneCaptureUiForChannel(guardedOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
      ...(guardedOutput.final_response.subject_intent != null ? { subject_intent: guardedOutput.final_response.subject_intent } : {}),
      ...(guardedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: guardedOutput.final_response.phone_ownership_intent } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    };
  }

  debug.finalization_reason = guardedOutput.type === "tool_requests"
    ? "guarded_multiple_booking_second_call_still_tool_requests"
    : "guarded_multiple_booking_second_call_malformed";
  markConversationDirty(debug);
  await clearConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
  return {
    final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
    conversation_id: null,
    conversation_id_resumable: false,
    tool_requests: toolRequests,
    tool_results: allResults,
    debug,
    ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
  };
}

// ── Guarded booking.apply helper ─────────────────────────────────────────────

export interface GuardedBookingApplyData {
  booking_status: string;
  created_visit: false;
  may_claim_booked: false;
  required_next_action: string;
  reason: string;
  missing_fields?: string[];
}

/**
 * When a booking.apply call is blocked by a deterministic preflight guard, this
 * helper submits a synthetic "guarded" tool_result for the pending call_id back
 * to the same OpenAI conversation instead of early-returning dirty.  The model
 * then produces a natural final_response (e.g. "please share your phone") while
 * conversation_id stays clean and resumable on the next patient turn.
 *
 * On failure of the second caller call the conversation IS marked dirty — the
 * pending function_call may be unresolved and the 400 risk is real.
 */
export async function finalizeBlockedBookingApplyWithToolOutput(params: {
  pendingBookingApply: RuntimeAgentToolRequest;
  guardedData: GuardedBookingApplyData;
  previousToolResults: RuntimeAgentToolResult[];
  toolRequests: RuntimeAgentToolRequest[];
  conversationId: string | null;
  systemInstruction: string;
  callerContext: Record<string, unknown>;
  input: RuntimeAgentTurnInput;
  debug: Record<string, unknown>;
  deps: CreateRuntimeAgentLoopDeps;
  execution_subject_id?: SubjectId | null;
  booking_subjects_after_resolution?: BookingSubjectsState | null;
  booking_apply_resolution?: BookingApplyResolution | null;
}): Promise<RuntimeAgentTurnResult> {
  const {
    pendingBookingApply, guardedData, previousToolResults, toolRequests,
    conversationId, systemInstruction, callerContext, input, debug, deps,
    execution_subject_id, booking_subjects_after_resolution, booking_apply_resolution,
  } = params;

  const guardedToolResult: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: pendingBookingApply.call_id,
    status: "success",
    data: guardedData,
  };

  const allResults = [...previousToolResults, guardedToolResult];
  const bookingApplyTruth = buildBookingApplyActionTruth(allResults);

  let guardedOutput: RuntimeAgentCallerOutput;
  try {
    guardedOutput = await deps.caller({
      model: deps.model,
      conversation_id: conversationId,
      system_instruction: systemInstruction,
      input: {
        message: input.user_message,
        context: {
          ...callerContext,
          ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
        },
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
        tool_results: [guardedToolResult],
      },
    });
  } catch (error) {
    debug.runtime_error = {
      code: "guarded_booking_apply_caller_failed",
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    };
    debug.finalization_reason = "guarded_booking_apply_caller_exception";
    debug.caller_exception = buildCallerExceptionDiagnostics(error, {
      stage: "second_call",
      locale: input.locale,
      conversationId,
      toolResults: allResults,
      bookingApplyActionTruth: bookingApplyTruth,
    });
    markConversationDirty(debug);
    await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
    return {
      final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
      conversation_id: null,
      conversation_id_resumable: false,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ...(execution_subject_id != null ? { execution_subject_id } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    };
  }

  let updatedConversationId = conversationId;
  if (guardedOutput.conversation_id !== undefined) {
    updatedConversationId = guardedOutput.conversation_id;
  }

  if (guardedOutput.type === "final_response" && !isMalformedFinalResponse(guardedOutput)) {
    await saveConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);

    // Sanitize model-emitted Telegram UI for non-Telegram channels before merging.
    const channel = typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined;
    let ui = sanitizePhoneCaptureUiForChannel(guardedOutput.final_response.ui, channel);
    // For phone guards, force the contact capture UI regardless of what the model returned —
    // the model may omit it, but the UI must always show it deterministically.
    if (guardedData.required_next_action === "ask_for_phone") {
      const captureUi = buildPhoneCaptureUi(channel);
      if (captureUi) {
        ui = { ...ui, ...captureUi, telegram: { ...(ui?.telegram ?? {}), ...(captureUi.telegram ?? {}) } };
      }
    }

    return {
      final_patient_reply: guardedOutput.final_response.final_patient_reply,
      conversation_id: updatedConversationId,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ui,
      ...(guardedOutput.final_response.subject_intent != null ? { subject_intent: guardedOutput.final_response.subject_intent } : {}),
      ...(guardedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: guardedOutput.final_response.phone_ownership_intent } : {}),
      ...(execution_subject_id != null ? { execution_subject_id } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    };
  }

  // Second caller returned further tool_requests or a malformed response — cannot
  // resolve cleanly.  Mark dirty so the conversation is not resumed with a pending call.
  debug.finalization_reason = guardedOutput.type === "tool_requests"
    ? "guarded_booking_apply_second_call_still_tool_requests"
    : "guarded_booking_apply_second_call_malformed";
  markConversationDirty(debug);
  await clearConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
  return {
    final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
    conversation_id: null,
    conversation_id_resumable: false,
    tool_requests: toolRequests,
    tool_results: allResults,
    debug,
    ...(execution_subject_id != null ? { execution_subject_id } : {}),
    ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
  };
}

// Returns true when at least one tool result has status=success with non-empty
// payload data. Empty chunks/slots are excluded — they provide no answer for
// the model to synthesize, so the generic fallback is still appropriate.
export function hasUsefulToolResults(results: RuntimeAgentToolResult[]): boolean {
  return results.some((r) => {
    if (r.status !== "success") return false;
    const data = r.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") return false;
    if ("chunks" in data && Array.isArray(data.chunks)) return data.chunks.length > 0;
    if ("slots" in data && Array.isArray(data.slots)) return data.slots.length > 0;
    return true;
  });
}

/** True when the caller returned a well-formed-looking final_response that is actually
 * a synthesized placeholder for output normalizeOpenAIResponse could not parse. */
export function isMalformedFinalResponse(output: RuntimeAgentCallerOutput): boolean {
  return (
    output.type === "final_response" &&
    Array.isArray(output.final_response.safety_notes) &&
    output.final_response.safety_notes.includes("malformed_openai_response")
  );
}

export function buildMalformedResponseFallback(locale?: string | null): string {
  const normalized = String(locale ?? "").toLowerCase();
  if (normalized.startsWith("cs")) {
    return "Teď se nepodařilo zprávu správně zpracovat. Zkuste to prosím znovu nebo kontaktujte kliniku přímo.";
  }
  if (normalized.startsWith("en")) {
    return "Sorry, I’m having trouble processing that right now. Please try again in a moment.";
  }
  return "Сейчас не получилось корректно обработать сообщение. Попробуйте, пожалуйста, ещё раз или свяжитесь с клиникой напрямую.";
}

export function buildMultiRoundFallbackReply(locale?: string | null): string {
  const normalized = String(locale ?? "").toLowerCase();
  if (normalized.startsWith("en")) {
    return "I'll clarify the details with the clinic team — one moment.";
  }
  if (normalized.startsWith("cs")) {
    return "Ověřím podrobnosti s týmem kliniky — chvilku prosím.";
  }
  return "Уточню детали с командой клиники — один момент.";
}

/**
 * Deterministically attaches the channel-appropriate contact capture UI when
 * booking_process_state.next_action === "ask_for_phone" and phone is not yet trusted.
 * Applied to all final_response return paths so the button appears even when the
 * model skips booking.apply and returns a plain text response asking for contact.
 * Preserves any existing ui fields; does not overwrite an already-set request_contact.
 */
export function maybeAttachPhoneRequestUI(
  bookingProcessState: ModelVisibleBookingProcessState | BookingProcessState | null,
  existingUi: AgentUiActions | undefined,
  channel?: string | null,
): AgentUiActions | undefined {
  // Always sanitize model-emitted Telegram contact UI for channels that don't permit it.
  let sanitized = sanitizePhoneCaptureUiForChannel(existingUi, channel);

  // If phone is already trusted, also strip any model-emitted contact request — we should
  // never ask the patient to share a phone we already have.
  if (bookingProcessState?.phone_trusted === true && sanitized?.telegram?.request_contact) {
    const { request_contact: _rc, button_text: _bt, ...restTelegram } = sanitized.telegram;
    const hasRemainingTelegram = Object.keys(restTelegram).length > 0;
    const { telegram: _tg, ...restUi } = sanitized;
    sanitized = hasRemainingTelegram
      ? { ...restUi, telegram: restTelegram }
      : Object.keys(restUi).length > 0 ? restUi : undefined;
  }

  // Only attach contact button when confidence is high (or not set, for compatibility with
  // the guarded booking.apply path which passes raw BookingProcessState).
  // Low-confidence state means next_action was derived from defaults without durable backing —
  // in that case we do not force a UI that may be wrong.
  const confidence = (bookingProcessState as ModelVisibleBookingProcessState)?.next_action_confidence;
  if (confidence === "low") return sanitized;

  if (
    bookingProcessState?.next_action === "ask_for_phone" &&
    bookingProcessState?.phone_trusted !== true
  ) {
    if (sanitized?.telegram?.request_contact) return sanitized;
    const captureUi = buildPhoneCaptureUi(channel);
    if (!captureUi) return sanitized;
    return {
      ...sanitized,
      ...captureUi,
      telegram: { ...(sanitized?.telegram ?? {}), ...(captureUi.telegram ?? {}) },
    };
  }
  return sanitized;
}

function buildPlannerFromAgentToolRequest(request: RuntimeAgentToolRequest): PlannerOutput {
  if (request.tool === "availability.check") {
    return {
      confidence: "high",
      tools_requested: ["availability.check"],
      reply_strategy: "answer_only",
      turn_type: "availability_request",
      booking_action: "check_availability",
    };
  }

  if (request.tool === "booking.apply") {
    return {
      confidence: "high",
      tools_requested: ["booking.apply"],
      reply_strategy: "answer_only",
      turn_type: "booking",
      booking_action: "confirm",
      explicit_patient_confirmation: true,
      booking_request: {
        service: typeof request.arguments.service === "string" ? request.arguments.service : null,
        preferred_date_text: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null,
        preferred_time_text: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
      },
    };
  }

  return {
    confidence: "high",
    tools_requested: ["kb.search"],
    reply_strategy: "answer_only",
    turn_type: "faq",
    booking_action: null,
  };
}

function resolveTruthSnapshot(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  now?: Date,
): TruthSnapshot {
  const provided = input.truth_snapshot;
  if (provided && typeof provided === "object") {
    const typed = provided as Partial<TruthSnapshot>;
    if (typeof typed.scheduling_intent_present === "boolean" && typeof typed.date_or_time_present === "boolean") {
      return typed as TruthSnapshot;
    }
  }

  return buildTruthSnapshot({
    planner,
    now,
    current_turn_flags: {
      scheduling_intent_present: request.tool === "availability.check" || request.tool === "booking.apply",
      date_or_time_present: typeof request.arguments.requested_date === "string"
        || typeof request.arguments.requested_time === "string",
    },
  });
}

function buildExecutionContext(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  truth_snapshot: TruthSnapshot,
  now?: Date,
  executionSubjectId?: SubjectId | null,
): ToolExecutionContext {
  // service_interest: availability.check uses "service_interest"; booking.apply uses "service".
  const serviceInterest =
    typeof request.arguments.service_interest === "string"
      ? request.arguments.service_interest
      : typeof request.arguments.service === "string"
        ? request.arguments.service
        : null;

  return {
    trace_id: input.trace_id,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? undefined,
    case_id: input.case_id ?? undefined,
    locale: input.locale,
    query_text: typeof request.arguments.query === "string" ? request.arguments.query : undefined,
    requested_date: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : undefined,
    requested_time: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
    service_interest: serviceInterest,
    limit: typeof request.arguments.limit === "number" ? request.arguments.limit : undefined,
    timezone: typeof request.arguments.timezone === "string" ? request.arguments.timezone : undefined,
    planner,
    truth_snapshot,
    now,
    // booking.apply phone: subject-aware when booking_subjects present, fallback to global contacts.
    // Uses frozen executionSubjectId when provided (from booking.apply.subject_id resolution).
    first_name: typeof request.arguments.first_name === "string" ? request.arguments.first_name : undefined,
    last_name: typeof request.arguments.last_name === "string" ? request.arguments.last_name : undefined,
    ...buildSubjectAwarePhoneFields(input, executionSubjectId),
  } as ToolExecutionContext;
}

/** Returns the active subject's phone fields for booking.apply, or falls back to global contacts. */
type SubjectLike = { id: string; booking_contact?: unknown };

/** Resolves booking phone fields from a booking_contact, handling shared_from_subject by
 *  looking up the owner subject's actual contact source. Never passes "shared_from_subject"
 *  to the executor — always resolves to the underlying original source. */
function resolveBookingContactFields(
  bc: Record<string, unknown>,
  allSubjects: SubjectLike[],
): { phone_number: string | undefined; phone_source: string | undefined; phone_trust: string | undefined } {
  if (bc.source === "shared_from_subject") {
    const ownerId = bc.owner_subject_id as string | null | undefined;
    if (!ownerId) return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    const owner = allSubjects.find((s) => s.id === ownerId);
    const ownerBc = (owner?.booking_contact ?? null) as Record<string, unknown> | null;
    if (!ownerBc?.phone_number) return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    return {
      phone_number: ownerBc.phone_number as string,
      phone_source: ownerBc.source as string | undefined,
      // Inherit owner trust — never upgrade typed/unverified to trusted
      phone_trust: ownerBc.trust === "trusted" ? "trusted" : "unverified",
    };
  }
  return {
    phone_number: bc.phone_number as string,
    phone_source: bc.source as string | undefined,
    phone_trust: (bc.trust === "trusted" || bc.trust === "trusted_contact_owner") ? "trusted" : "unverified",
  };
}

/**
 * Returns phone fields for booking.apply execution, using the resolved execution subject
 * when booking_subjects registry is active. Falls back to global phone contacts otherwise.
 * @param executionSubjectId - frozen subject id from resolveBookingExecutionSubject(); overrides active_subject_id
 */
function buildSubjectAwarePhoneFields(
  input: RuntimeAgentTurnInput,
  executionSubjectId?: SubjectId | null,
): {
  phone_number: string | undefined;
  phone_source: string | undefined;
  phone_trust: string | undefined;
} {
  if (input.booking_subjects) {
    // Registry active: execution subject must be explicit — no fallback to active_subject_id.
    if (!executionSubjectId) return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    const subjects = input.booking_subjects.subjects as SubjectLike[];
    const target = subjects.find((s) => s.id === executionSubjectId);
    const bc = (target?.booking_contact ?? null) as Record<string, unknown> | null;
    if (bc?.phone_number) return resolveBookingContactFields(bc, subjects);
    return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
  }
  // Single-subject (no registry): suppress legacy typed provided_phone if this conversation
  // ever had a multi-subject registry — old ownerless typed phone must not leak into self-booking.
  // Exception: a typed phone that was entered THIS turn is fresh and must be used.
  const isCurrentTurnTypedPhone =
    input.current_turn_typed_phone != null &&
    input.provided_phone?.phone_source === "typed" &&
    input.provided_phone.phone_number === input.current_turn_typed_phone;
  const suppressTypedPhone =
    input.had_booking_subjects &&
    input.provided_phone?.phone_source === "typed" &&
    !isCurrentTurnTypedPhone;
  const effectiveProvided = suppressTypedPhone ? null : (input.provided_phone ?? null);
  return {
    phone_number: effectiveProvided?.phone_number ?? input.channel_contact?.phone_number,
    phone_source: effectiveProvided?.phone_source ?? input.channel_contact?.phone_source,
    phone_trust: effectiveProvided ? effectiveProvided.phone_trust : undefined,
  };
}

/**
 * True when the resolved execution subject has a phone suitable for booking.
 * With an active registry, executionSubjectId must be explicit — no fallback to active_subject_id.
 * Without a registry, falls back to global channel_contact / provided_phone.
 */
function hasSubjectOrContactPhone(input: RuntimeAgentTurnInput, executionSubjectId: SubjectId | null): boolean {
  if (input.booking_subjects) {
    // Registry active but no resolved execution subject → no phone (prevents active-subject bypass)
    if (!executionSubjectId) return false;
    const subjects = input.booking_subjects.subjects as SubjectLike[];
    const target = subjects.find((s) => s.id === executionSubjectId);
    const bc = (target?.booking_contact ?? null) as Record<string, unknown> | null;
    if (!bc?.phone_number) return false;
    if (bc.source === "shared_from_subject") {
      const ownerId = bc.owner_subject_id as string | null | undefined;
      if (!ownerId) return false;
      const owner = subjects.find((s) => s.id === ownerId);
      const ownerBc = (owner?.booking_contact ?? null) as Record<string, unknown> | null;
      return ownerBc?.phone_number != null;
    }
    return true;
  }
  // Suppress legacy typed provided_phone when conversation had multi-subject registry,
  // unless the phone was entered this turn (fresh).
  const isCurrentTurnTypedPhoneForHas =
    input.current_turn_typed_phone != null &&
    input.provided_phone?.phone_source === "typed" &&
    input.provided_phone.phone_number === input.current_turn_typed_phone;
  const suppressTypedPhone =
    input.had_booking_subjects &&
    input.provided_phone?.phone_source === "typed" &&
    !isCurrentTurnTypedPhoneForHas;
  const effectiveProvided = suppressTypedPhone ? null : (input.provided_phone ?? null);
  return hasBookingContactPhone({ channelContact: input.channel_contact, providedPhone: effectiveProvided });
}

function convertToolExecutionResult(
  request: RuntimeAgentToolRequest,
  result: ToolExecutionResult | undefined,
): RuntimeAgentToolResult {
  if (!result) {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: { code: "missing_execution_result", message: "Tool execution produced no result" },
    };
  }

  if (result.status === "success") {
    return { tool: request.tool, call_id: request.call_id, status: "success", data: result.data };
  }

  if (result.status === "not_implemented") {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: result.error ?? { code: "tool_not_implemented", message: "Tool not implemented", retryable: false },
    };
  }

  return {
    tool: request.tool,
    call_id: request.call_id,
    status: "failed",
    error: result.error,
  };
}

/** Marks debug so callers/logs can see the OpenAI conversation_id for this turn
 * must not be persisted/resumed — it has a pending function_call with no
 * function_call_output submitted (see forced-finalization branches above). */
function markConversationDirty(debug: Record<string, unknown>): void {
  debug.openai_conversation_resumable = false;
  debug.conversation_id_reset_reason = "pending_tool_call_after_forced_finalization";
}

async function saveConversationMemory(
  repository: ConversationMemoryRepository | undefined,
  input: RuntimeAgentTurnInput,
  conversationId: string | null,
  debug: Record<string, unknown>,
): Promise<void> {
  if (!repository || !conversationId) {
    return;
  }
  try {
    const saveResult = await repository.saveConversationMemory({
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      case_id: input.case_id,
      conversation_id: conversationId,
    });
    debug.memory_saved = saveResult.ok;
    if (!saveResult.ok) {
      debug.memory_save_error = saveResult.error;
    }
  } catch (error) {
    debug.memory_saved = false;
    debug.memory_save_error = error instanceof Error ? error.message : String(error);
  }
}

/** Explicitly clears agent-level conversation memory when a conversation just went dirty
 * (see markConversationDirty). saveConversationMemory() alone won't do this — its early
 * return on a falsy conversationId means passing null there is a silent no-op, leaving any
 * previously stored value in place to be resumed (and fail with the same upstream 400) on
 * the next turn. No-ops when there was nothing to clear (dirtyConversationId was already null). */
async function clearConversationMemory(
  repository: ConversationMemoryRepository | undefined,
  input: RuntimeAgentTurnInput,
  dirtyConversationId: string | null,
  debug: Record<string, unknown>,
): Promise<void> {
  if (!repository || !dirtyConversationId) {
    return;
  }
  try {
    const saveResult = await repository.saveConversationMemory({
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      case_id: input.case_id,
      conversation_id: "",
    });
    debug.memory_cleared = saveResult.ok;
    if (!saveResult.ok) {
      debug.memory_save_error = saveResult.error;
    }
  } catch (error) {
    debug.memory_cleared = false;
    debug.memory_save_error = error instanceof Error ? error.message : String(error);
  }
}
