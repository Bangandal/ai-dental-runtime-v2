from pathlib import Path

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    source = source.replace(old, new, 1)


replace_once(
    'import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n',
    'import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n'
    'import { executeRuntimeNonWriteToolBatch } from "./runtimeNonWriteToolBatch.ts";\n',
    "non-write batch import",
)

replace_once(
    '        const allRound2BookingRequests = secondOutput.tool_requests.filter((r) => r.tool === "booking.apply");\n'
    '        const pendingBookingApply = allRound2BookingRequests[0] ?? null;\n',
    '        const allRound2BookingRequests = secondOutput.tool_requests.filter((r) => r.tool === "booking.apply");\n'
    '        const pendingBookingApply = allRound2BookingRequests[0] ?? null;\n'
    '        const round2StateBeforeBatch = bookingProcessState;\n'
    '        const round2ToolResults: RuntimeAgentToolResult[] = [];\n',
    "round2 batch state",
)

replace_once(
    '        if (round2SelectApplyConflict) {\n'
    '          toolResults.push(...round2SelectApplyConflict.tool_results);\n',
    '        if (round2SelectApplyConflict) {\n'
    '          round2ToolResults.push(...round2SelectApplyConflict.tool_results);\n'
    '          toolResults.push(...round2SelectApplyConflict.tool_results);\n',
    "conflict result ownership",
)

old_selection = '''        } else if (round2SlotSelection.attempted) {
          toolResults.push(...round2SlotSelection.tool_results);
          bookingProcessState = computeBookingProcessState({
            prior: bookingProcessState,
            channelContact: input.channel_contact,
            selectSlotData: round2SlotSelection.success_data,
            // Any selection attempt, including failed/ambiguous, revokes the previous proof.
            selectSlotAttemptedThisTurn: true,
            now: turnNow,
          });

          if (deps.bookingProcessStateRepository) {
            deps.bookingProcessStateRepository.saveState(
              { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
              bookingProcessState,
              (info) => { if (!info.saved) debug.booking_process_state_save = info; },
            ).catch(() => undefined);
          }
        }

        // 6. No-slots gate — fires AFTER Guard J, bootstrap, and execution subject freeze.
'''

new_selection = '''        } else if (round2SlotSelection.attempted) {
          // Keep the current batch outputs separate until every non-write call id has
          // been resolved. This is what lets the third model step continue the SAME
          // conversation instead of abandoning it for a fresh forced-finalization call.
          round2ToolResults.push(...round2SlotSelection.tool_results);

          // Write-bearing batches keep the historical immediate state transition for now.
          // Non-write batches below apply selection + availability as one atomic batch
          // transition so a same-batch availability refresh wins and revokes old proof.
          if (pendingBookingApply) {
            toolResults.push(...round2SlotSelection.tool_results);
            bookingProcessState = computeBookingProcessState({
              prior: bookingProcessState,
              channelContact: input.channel_contact,
              selectSlotData: round2SlotSelection.success_data,
              // Any selection attempt, including failed/ambiguous, revokes the previous proof.
              selectSlotAttemptedThisTurn: true,
              now: turnNow,
            });

            if (deps.bookingProcessStateRepository) {
              deps.bookingProcessStateRepository.saveState(
                { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
                bookingProcessState,
                (info) => { if (!info.saved) debug.booking_process_state_save = info; },
              ).catch(() => undefined);
            }
          }
        }

        // R3q bounded continuation: a later tool batch without booking.apply is fully
        // executed, every pending call id is closed, and the outputs are submitted back
        // to the SAME conversation for one final model step. This is the first production
        // model -> tools -> model -> tools -> model path; max model calls remains three.
        if (!pendingBookingApply) {
          const nonWriteExecution = await executeRuntimeNonWriteToolBatch({
            requests: secondOutput.tool_requests,
            input: effectiveInput,
            executors: deps.executors,
            now: turnNow,
          });
          if (nonWriteExecution.availability_diagnostic !== undefined) {
            debug.availability_diagnostic = nonWriteExecution.availability_diagnostic;
          }

          // Reassemble outputs in model-request order. booking.select_slot results come
          // from the slot kernel; every other request is owned by the non-write executor.
          const selectResults = [...round2ToolResults];
          const nonWriteResults = [...nonWriteExecution.tool_results];
          let selectIndex = 0;
          let nonWriteIndex = 0;
          const orderedRound2Results: RuntimeAgentToolResult[] = [];
          for (const request of secondOutput.tool_requests) {
            const result = request.tool === "booking.select_slot"
              ? selectResults[selectIndex++]
              : nonWriteResults[nonWriteIndex++];
            if (result) orderedRound2Results.push(result);
          }
          round2ToolResults.length = 0;
          round2ToolResults.push(...orderedRound2Results);
          toolResults.push(...orderedRound2Results);

          // Apply the whole batch as one deterministic state transition. If availability
          // and select_slot coexist, computeBookingProcessState intentionally lets the
          // fresh availability attempt supersede selection proof from the same batch.
          const round2AvailabilityAttempt = resolveAuthoritativeAvailabilityAttempt(
            secondOutput.tool_requests,
            round2ToolResults,
          );
          bookingProcessState = computeBookingProcessState({
            prior: round2StateBeforeBatch,
            authoritativeAvailabilityAttempt: round2AvailabilityAttempt,
            channelContact: input.channel_contact,
            selectSlotData: round2SlotSelection.success_data,
            selectSlotAttemptedThisTurn: round2SlotSelection.attempted,
            now: turnNow,
          });

          if (deps.bookingProcessStateRepository) {
            deps.bookingProcessStateRepository.saveState(
              { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
              bookingProcessState,
              (info) => { if (!info.saved) debug.booking_process_state_save = info; },
            ).catch(() => undefined);
          }

          const boundedBookingTruth = buildBookingApplyActionTruth(toolResults);
          const boundedAvailabilityAttempt = resolveAuthoritativeAvailabilityAttempt(
            processedToolRequests,
            toolResults,
          );
          const boundedAvailabilityTruth = buildAvailabilityActionTruth(boundedAvailabilityAttempt);
          const boundedAvailabilityPresentation = buildAvailabilityPresentationTruth(boundedAvailabilityAttempt);
          const boundedAppointmentTruth = buildAppointmentDisplayTruth(toolResults);
          const boundedHasBookingToolResult = toolResults.some(
            (r) => r.tool === "availability.check" || r.tool === "booking.apply" || r.tool === "booking.select_slot",
          );
          const boundedGrounded =
            (priorProcessState !== null && hasMeaningfulBookingState(priorProcessState)) ||
            boundedHasBookingToolResult ||
            bookingProcessState.selected_slot != null;
          const boundedVisibleState = buildModelVisibleBookingProcessState({
            state: bookingProcessState,
            priorProcessState,
            bookingStateGrounded: boundedGrounded,
            now: turnNow,
            timezone,
          });

          const boundedCall = await invokeRuntimeModelCall({
            caller: deps.caller,
            model: deps.model,
            conversation_id: conversationId,
            system_instruction: systemInstruction,
            message: input.user_message,
            context: composeRuntimeModelContext(callerContext, {
              booking_apply_action_truth: boundedBookingTruth,
              availability_action_truth: boundedAvailabilityTruth,
              availability_presentation_truth: boundedAvailabilityPresentation,
              appointment_display_truth: boundedAppointmentTruth,
              booking_process_state: boundedVisibleState,
            }),
            // Resolve exactly the pending second batch. No tool definitions on the final
            // budgeted step: a further tool request is treated as budget exhaustion.
            tool_results: round2ToolResults,
          });

          if (!boundedCall.ok) {
            const error = boundedCall.error;
            debug.reason = "bounded_tool_batch_final_call_exception";
            debug.runtime_error = {
              code: "agent_bounded_final_response_failed",
              message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
            };
            debug.caller_exception = buildCallerExceptionDiagnostics(error, {
              stage: "forced_finalization",
              locale: input.locale,
              conversationId,
              toolResults,
              bookingApplyActionTruth: boundedBookingTruth,
            });
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: boundedBookingTruth
                ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
                : buildMultiRoundFallbackReply(input.locale),
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

          const boundedOutput = boundedCall.output;
          conversationId = boundedCall.conversation_id;

          if (boundedOutput.type === "tool_requests") {
            // We intentionally do not execute a third tool batch in this slice. Keep the
            // unclosed requests observable, dirty the conversation, and fail closed.
            processedToolRequests.push(...boundedOutput.tool_requests);
            debug.reason = "bounded_tool_batch_budget_exhausted";
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: boundedBookingTruth
                ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
                : buildMultiRoundFallbackReply(input.locale),
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

          if (isMalformedFinalResponse(boundedOutput)) {
            debug.reason = "malformed_bounded_tool_batch_final_response";
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: boundedBookingTruth
                ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
                : buildMultiRoundFallbackReply(input.locale),
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

          debug.reason = "bounded_tool_batch_final_response";
          await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: boundedOutput.final_response.final_patient_reply,
            conversation_id: conversationId,
            tool_requests: processedToolRequests,
            tool_results: toolResults,
            debug,
            ui: maybeAttachPhoneRequestUI(
              boundedVisibleState,
              boundedOutput.final_response.ui,
              typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined,
            ),
            ...(boundedOutput.final_response.subject_intent != null ? { subject_intent: boundedOutput.final_response.subject_intent } : {}),
            ...(boundedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: boundedOutput.final_response.phone_ownership_intent } : {}),
            ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
            ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
          };
        }

        // 6. No-slots gate — fires AFTER Guard J, bootstrap, and execution subject freeze.
'''

replace_once(old_selection, new_selection, "bounded second batch continuation")

path.write_text(source)
print("R3q patch applied")
