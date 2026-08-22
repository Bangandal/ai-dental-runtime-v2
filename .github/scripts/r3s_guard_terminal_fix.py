from pathlib import Path

p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

replacements = [
    (
        '      const secondCall = await invokeRuntimeModelCall({\n',
        '      // Ordinary first-batch booking guards are terminal decisions: after the runtime\n'
        '      // has deterministically asked for phone/name/service/slot or rejected past time,\n'
        '      // the next model step only needs to phrase the reply. Guard S is different: it\n'
        '      // leaves round1GuardedData null so the model may legitimately retry booking.apply\n'
        '      // after select_slot proof was persisted.\n'
        '      const secondCallAllowsTools = round1GuardedData === null;\n\n'
        '      const secondCall = await invokeRuntimeModelCall({\n',
        'insert terminal-mode flag',
    ),
    (
        '        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n        tool_results: toolResults,\n',
        '        ...(secondCallAllowsTools ? { tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS } : {}),\n'
        '        tool_results: toolResults,\n',
        'conditional second-call tools',
    ),
    (
        '      if (secondOutput.type === "tool_requests") {\n',
        '      if (!secondCallAllowsTools && secondOutput.type === "tool_requests") {\n'
        '        // Fail closed if a terminal model step violates the no-tools contract. The\n'
        '        // deterministic booking guard remains the authoritative reason for the turn.\n'
        '        debug.terminal_tool_request_ignored = true;\n'
        '        markConversationDirty(debug);\n'
        '        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n'
        '        const channel = typeof input.business_context?.channel === "string"\n'
        '          ? input.business_context.channel\n'
        '          : undefined;\n'
        '        return {\n'
        '          final_patient_reply: buildBookingApplyEmergencyFallback(toolResults, input.locale),\n'
        '          conversation_id: null,\n'
        '          conversation_id_resumable: false,\n'
        '          tool_requests: processedToolRequests,\n'
        '          tool_results: toolResults,\n'
        '          debug,\n'
        '          ...(round1GuardedData?.required_next_action === "ask_for_phone"\n'
        '            ? { ui: buildPhoneCaptureUi(channel) }\n'
        '            : {}),\n'
        '          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),\n'
        '          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),\n'
        '          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),\n'
        '        };\n'
        '      }\n\n'
        '      if (secondOutput.type === "tool_requests") {\n',
        'terminal tool-request fail-close',
    ),
    (
        '        if (!guardSFired && pendingBookingApply && toolResults.some((r) => r.tool === "booking.apply")) {\n',
        '        if (pendingBookingApply && round1BookingApplyResolution !== null) {\n',
        'one-write criterion',
    ),
]

for old, new, label in replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    s = s.replace(old, new, 1)

p.write_text(s)
