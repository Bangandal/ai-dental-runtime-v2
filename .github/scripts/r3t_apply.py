from pathlib import Path

p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

replacements = [
    (
        'import { invokeRuntimeModelCall, type RuntimeAgentCaller, type RuntimeAgentCallerInput, type RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n',
        'import { invokeRuntimeModelCall, type RuntimeAgentCaller, type RuntimeAgentCallerInput, type RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n'
        'import { createRuntimeModelIterationState, invokeRuntimeModelIteration } from "./runtimeModelIteration.ts";\n',
        'iteration import',
    ),
    (
        '      const callerContext = buildModelVisibleCallerContext(input);\n',
        '      let modelIteration = createRuntimeModelIterationState(conversationId);\n\n'
        '      const callerContext = buildModelVisibleCallerContext(input);\n',
        'iteration state initialization',
    ),
    (
        '      const firstCall = await invokeRuntimeModelCall({\n'
        '        caller: deps.caller,\n'
        '        model: deps.model,\n'
        '        conversation_id: conversationId,\n'
        '        system_instruction: systemInstruction,\n'
        '        message: input.user_message,\n'
        '        context: composeRuntimeModelContext(callerContext, { booking_process_state: firstCallVisibleState }),\n'
        '        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n'
        '      });\n'
        '      if (!firstCall.ok) {\n'
        '        const error = firstCall.error;\n',
        '      const firstStep = await invokeRuntimeModelIteration({\n'
        '        state: modelIteration,\n'
        '        caller: deps.caller,\n'
        '        model: deps.model,\n'
        '        system_instruction: systemInstruction,\n'
        '        message: input.user_message,\n'
        '        context: composeRuntimeModelContext(callerContext, { booking_process_state: firstCallVisibleState }),\n'
        '        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n'
        '      });\n'
        '      modelIteration = firstStep.state;\n'
        '      conversationId = modelIteration.conversation_id;\n'
        '      if (firstStep.kind === "budget_exhausted") {\n'
        '        debug.reason = "model_call_budget_exhausted_before_first_call";\n'
        '        return {\n'
        '          final_patient_reply: buildMalformedResponseFallback(input.locale),\n'
        '          conversation_id: conversationId,\n'
        '          conversation_id_resumable: false,\n'
        '          tool_requests: [],\n'
        '          tool_results: [],\n'
        '          debug,\n'
        '        };\n'
        '      }\n'
        '      if (firstStep.kind === "call_failed") {\n'
        '        const error = firstStep.error;\n',
        'first model iteration',
    ),
    (
        '      const firstOutput = firstCall.output;\n'
        '      conversationId = firstCall.conversation_id;\n',
        '      const firstOutput = firstStep.output;\n',
        'first output binding',
    ),
    (
        '      const secondCall = await invokeRuntimeModelCall({\n'
        '        caller: deps.caller,\n'
        '        model: deps.model,\n'
        '        conversation_id: conversationId,\n'
        '        system_instruction: systemInstruction,\n'
        '        message: input.user_message,\n'
        '        context: secondCallContext,\n'
        '        ...(secondCallAllowsTools ? { tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS } : {}),\n'
        '        tool_results: toolResults,\n'
        '      });\n'
        '      if (!secondCall.ok) {\n'
        '        const error = secondCall.error;\n',
        '      const secondStep = await invokeRuntimeModelIteration({\n'
        '        state: modelIteration,\n'
        '        caller: deps.caller,\n'
        '        model: deps.model,\n'
        '        system_instruction: systemInstruction,\n'
        '        message: input.user_message,\n'
        '        context: secondCallContext,\n'
        '        ...(secondCallAllowsTools ? { tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS } : {}),\n'
        '        tool_results: toolResults,\n'
        '      });\n'
        '      modelIteration = secondStep.state;\n'
        '      conversationId = modelIteration.conversation_id;\n'
        '      if (secondStep.kind === "budget_exhausted") {\n'
        '        debug.reason = "model_call_budget_exhausted_before_second_call";\n'
        '        markConversationDirty(debug);\n'
        '        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n'
        '        return {\n'
        '          final_patient_reply: bookingActionTruth\n'
        '            ? buildBookingApplyEmergencyFallback(toolResults, input.locale)\n'
        '            : buildMalformedResponseFallback(input.locale),\n'
        '          conversation_id: null,\n'
        '          conversation_id_resumable: false,\n'
        '          tool_requests: toolRequests,\n'
        '          tool_results: toolResults,\n'
        '          debug,\n'
        '          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),\n'
        '          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),\n'
        '          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),\n'
        '        };\n'
        '      }\n'
        '      if (secondStep.kind === "call_failed") {\n'
        '        const error = secondStep.error;\n',
        'second model iteration',
    ),
    (
        '      const secondOutput = secondCall.output;\n'
        '      conversationId = secondCall.conversation_id;\n',
        '      const secondOutput = secondStep.output;\n',
        'second output binding',
    ),
    (
        '        const boundedCall = await invokeRuntimeModelCall({\n'
        '          caller: deps.caller,\n'
        '          model: deps.model,\n'
        '          conversation_id: conversationId,\n'
        '          system_instruction: systemInstruction,\n'
        '          message: input.user_message,\n'
        '          context: composeRuntimeModelContext(callerContext, {\n'
        '            booking_apply_action_truth: boundedBookingTruth,\n'
        '            availability_action_truth: boundedAvailabilityTruth,\n'
        '            availability_presentation_truth: boundedAvailabilityPresentation,\n'
        '            appointment_display_truth: boundedAppointmentTruth,\n'
        '            booking_process_state: boundedVisibleState,\n'
        '          }),\n'
        '          // Current batch is fully resolved. No tool definitions on the terminal budgeted\n'
        '          // model step, so no fourth hidden model/tool cycle can begin.\n'
        '          tool_results: resolvedRound2Results,\n'
        '        });\n\n'
        '        const finalExecutionSubjectId = round2ExecutionSubjectId ?? round1ExecutionSubjectId;\n'
        '        const finalBookingApplyResolution = round2BookingApplyResolution ?? round1BookingApplyResolution;\n\n'
        '        if (!boundedCall.ok) {\n'
        '          const error = boundedCall.error;\n',
        '        const boundedStep = await invokeRuntimeModelIteration({\n'
        '          state: modelIteration,\n'
        '          caller: deps.caller,\n'
        '          model: deps.model,\n'
        '          system_instruction: systemInstruction,\n'
        '          message: input.user_message,\n'
        '          context: composeRuntimeModelContext(callerContext, {\n'
        '            booking_apply_action_truth: boundedBookingTruth,\n'
        '            availability_action_truth: boundedAvailabilityTruth,\n'
        '            availability_presentation_truth: boundedAvailabilityPresentation,\n'
        '            appointment_display_truth: boundedAppointmentTruth,\n'
        '            booking_process_state: boundedVisibleState,\n'
        '          }),\n'
        '          tool_results: resolvedRound2Results,\n'
        '        });\n'
        '        modelIteration = boundedStep.state;\n'
        '        conversationId = modelIteration.conversation_id;\n\n'
        '        const finalExecutionSubjectId = round2ExecutionSubjectId ?? round1ExecutionSubjectId;\n'
        '        const finalBookingApplyResolution = round2BookingApplyResolution ?? round1BookingApplyResolution;\n\n'
        '        if (boundedStep.kind === "budget_exhausted") {\n'
        '          debug.reason = "bounded_tool_batch_budget_exhausted_before_final_call";\n'
        '          markConversationDirty(debug);\n'
        '          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n'
        '          return {\n'
        '            final_patient_reply: boundedBookingTruth\n'
        '              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)\n'
        '              : buildMultiRoundFallbackReply(input.locale),\n'
        '            conversation_id: null,\n'
        '            conversation_id_resumable: false,\n'
        '            tool_requests: processedToolRequests,\n'
        '            tool_results: toolResults,\n'
        '            debug,\n'
        '            ...(finalExecutionSubjectId != null ? { execution_subject_id: finalExecutionSubjectId } : {}),\n'
        '            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),\n'
        '            ...(finalBookingApplyResolution != null ? { booking_apply_resolution: finalBookingApplyResolution } : {}),\n'
        '          };\n'
        '        }\n\n'
        '        if (boundedStep.kind === "call_failed") {\n'
        '          const error = boundedStep.error;\n',
        'bounded model iteration',
    ),
    (
        '        const boundedOutput = boundedCall.output;\n'
        '        conversationId = boundedCall.conversation_id;\n',
        '        const boundedOutput = boundedStep.output;\n',
        'bounded output binding',
    ),
]

for old, new, label in replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    s = s.replace(old, new, 1)

p.write_text(s)
