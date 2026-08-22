from pathlib import Path
import re

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

# Move caller protocol types to the shared transport boundary.
source = source.replace('  type RuntimeAgentFinalResponse,\n', '', 1)
anchor = 'import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";\n'
assert anchor in source
source = source.replace(
    anchor,
    anchor + 'import { invokeRuntimeModelCall, type RuntimeAgentCaller, type RuntimeAgentCallerInput, type RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n'
    + 'export type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";\n',
    1,
)

source, count = re.subn(
    r'export interface RuntimeAgentCallerInput \{.*?export type RuntimeAgentCaller = \(input: RuntimeAgentCallerInput\) => Promise<RuntimeAgentCallerOutput>;\n\n',
    '',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"caller type block removal count={count}"

# First model call: transport outcome owns conversation-id propagation, while legacy fallback stays local.
first_pattern = re.compile(r'''      let firstOutput: RuntimeAgentCallerOutput;\n      try \{\n        debug\.llm_calls = buildRuntimeLlmCallDebug\(\{ main_agent_called: true \}\);\n        firstOutput = await deps\.caller\(\{\n          model: deps\.model,\n          conversation_id: conversationId,\n          system_instruction: systemInstruction,\n          input: \{\n            message: input\.user_message,\n            context: \{ \.\.\.callerContext, booking_process_state: firstCallVisibleState \},\n            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n          \},\n        \}\);\n      \} catch \(error\) \{''')
first_replacement = '''      debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
      const firstCall = await invokeRuntimeModelCall({
        caller: deps.caller,
        model: deps.model,
        conversation_id: conversationId,
        system_instruction: systemInstruction,
        message: input.user_message,
        context: { ...callerContext, booking_process_state: firstCallVisibleState },
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
      });
      if (!firstCall.ok) {
        const error = firstCall.error;'''
source, count = first_pattern.subn(first_replacement, source, count=1)
assert count == 1, f"first call replacement count={count}"
source, count = re.subn(
    r'      if \(firstOutput\.conversation_id !== undefined\) \{\n        conversationId = firstOutput\.conversation_id;\n      \}',
    '      const firstOutput = firstCall.output;\n      conversationId = firstCall.conversation_id;',
    source,
    count=1,
)
assert count == 1, f"first conversation update count={count}"

# Second model call.
second_pattern = re.compile(r'''      let secondOutput: RuntimeAgentCallerOutput;\n      try \{\n        secondOutput = await deps\.caller\(\{\n          model: deps\.model,\n          conversation_id: conversationId,\n          system_instruction: systemInstruction,\n          input: \{\n            message: input\.user_message,\n            context: secondCallContext,\n            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n            tool_results: toolResults,\n          \},\n        \}\);\n      \} catch \(error\) \{''')
second_replacement = '''      const secondCall = await invokeRuntimeModelCall({
        caller: deps.caller,
        model: deps.model,
        conversation_id: conversationId,
        system_instruction: systemInstruction,
        message: input.user_message,
        context: secondCallContext,
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
        tool_results: toolResults,
      });
      if (!secondCall.ok) {
        const error = secondCall.error;'''
source, count = second_pattern.subn(second_replacement, source, count=1)
assert count == 1, f"second call replacement count={count}"
source, count = re.subn(
    r'      if \(secondOutput\.conversation_id !== undefined\) \{\n        conversationId = secondOutput\.conversation_id;\n      \}',
    '      const secondOutput = secondCall.output;\n      conversationId = secondCall.conversation_id;',
    source,
    count=1,
)
assert count == 1, f"second conversation update count={count}"

# Fresh forced finalization after a later booking.apply. Exception behavior remains local.
booking_final_pattern = re.compile(r'''          let bookingFinalOutput: RuntimeAgentCallerOutput \| undefined;\n          try \{\n            bookingFinalOutput = await deps\.caller\(\{\n              model: deps\.model,\n              conversation_id: null,\n              system_instruction: systemInstruction,\n              input: \{\n                message: input\.user_message,\n                context: \{\n                  \.\.\.callerContext,\n                  resolved_context: allResults,\n                  \.\.\.\(bookingApplyTruth \? \{ booking_apply_action_truth: bookingApplyTruth \} : \{\}\),\n                  \.\.\.\(bookingApplyDisplayTruth \? \{ appointment_display_truth: bookingApplyDisplayTruth \} : \{\}\),\n                \},\n              \},\n            \}\);\n          \} catch \(error\) \{''')
booking_final_replacement = '''          const bookingFinalCall = await invokeRuntimeModelCall({
            caller: deps.caller,
            model: deps.model,
            conversation_id: null,
            system_instruction: systemInstruction,
            message: input.user_message,
            context: {
              ...callerContext,
              resolved_context: allResults,
              ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
              ...(bookingApplyDisplayTruth ? { appointment_display_truth: bookingApplyDisplayTruth } : {}),
            },
          });
          let bookingFinalOutput: RuntimeAgentCallerOutput | undefined;
          if (bookingFinalCall.ok) {
            bookingFinalOutput = bookingFinalCall.output;
          } else {
            const error = bookingFinalCall.error;'''
source, count = booking_final_pattern.subn(booking_final_replacement, source, count=1)
assert count == 1, f"booking forced finalization replacement count={count}"

# Generic fresh forced finalization after useful results.
forced_pattern = re.compile(r'''          let forcedOutput: RuntimeAgentCallerOutput \| undefined;\n          try \{\n            forcedOutput = await deps\.caller\(\{\n              model: deps\.model,\n              conversation_id: null,\n              system_instruction: systemInstruction,\n              input: \{\n                message: input\.user_message,\n                context: \{\n                  \.\.\.callerContext,\n                  resolved_context: toolResults,\n                  \.\.\.\(bookingActionTruth \? \{ booking_apply_action_truth: bookingActionTruth \} : \{\}\),\n                  \.\.\.\(appointmentDisplayTruth \? \{ appointment_display_truth: appointmentDisplayTruth \} : \{\}\),\n                \},\n                // No tool_definitions → caller sends tools:\[\] → model must produce final_response\.\n                // No tool_results → no function_call_output protocol messages\.\n              \},\n            \}\);\n          \} catch \(error\) \{''')
forced_replacement = '''          const forcedCall = await invokeRuntimeModelCall({
            caller: deps.caller,
            model: deps.model,
            conversation_id: null,
            system_instruction: systemInstruction,
            message: input.user_message,
            context: {
              ...callerContext,
              resolved_context: toolResults,
              ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
              ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
            },
            // No tool_definitions/tool_results: fresh caller must produce final_response.
          });
          let forcedOutput: RuntimeAgentCallerOutput | undefined;
          if (forcedCall.ok) {
            forcedOutput = forcedCall.output;
          } else {
            const error = forcedCall.error;'''
source, count = forced_pattern.subn(forced_replacement, source, count=1)
assert count == 1, f"generic forced finalization replacement count={count}"

# Guarded multiple-booking finalizer.
guarded_multi_pattern = re.compile(r'''  let guardedOutput: RuntimeAgentCallerOutput;\n  try \{\n    guardedOutput = await deps\.caller\(\{\n      model: deps\.model,\n      conversation_id: conversationId,\n      system_instruction: systemInstruction,\n      input: \{\n        message: input\.user_message,\n        context: \{\n          \.\.\.callerContext,\n          \.\.\.\(bookingApplyTruth \? \{ booking_apply_action_truth: bookingApplyTruth \} : \{\}\),\n        \},\n        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n        tool_results: guardedResults,\n      \},\n    \}\);\n  \} catch \(error\) \{''')
guarded_multi_replacement = '''  const guardedCall = await invokeRuntimeModelCall({
    caller: deps.caller,
    model: deps.model,
    conversation_id: conversationId,
    system_instruction: systemInstruction,
    message: input.user_message,
    context: {
      ...callerContext,
      ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
    },
    tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    tool_results: guardedResults,
  });
  if (!guardedCall.ok) {
    const error = guardedCall.error;'''
source, count = guarded_multi_pattern.subn(guarded_multi_replacement, source, count=1)
assert count == 1, f"guarded multiple replacement count={count}"
source, count = re.subn(
    r'  let updatedConversationId = conversationId;\n  if \(guardedOutput\.conversation_id !== undefined\) \{\n    updatedConversationId = guardedOutput\.conversation_id;\n  \}',
    '  const guardedOutput = guardedCall.output;\n  const updatedConversationId = guardedCall.conversation_id;',
    source,
    count=1,
)
assert count == 1, f"guarded multiple conversation update count={count}"

# Guarded single-booking finalizer has the same output variable but one guarded result.
guarded_single_pattern = re.compile(r'''  let guardedOutput: RuntimeAgentCallerOutput;\n  try \{\n    guardedOutput = await deps\.caller\(\{\n      model: deps\.model,\n      conversation_id: conversationId,\n      system_instruction: systemInstruction,\n      input: \{\n        message: input\.user_message,\n        context: \{\n          \.\.\.callerContext,\n          \.\.\.\(bookingApplyTruth \? \{ booking_apply_action_truth: bookingApplyTruth \} : \{\}\),\n        \},\n        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,\n        tool_results: \[guardedToolResult\],\n      \},\n    \}\);\n  \} catch \(error\) \{''')
guarded_single_replacement = '''  const guardedCall = await invokeRuntimeModelCall({
    caller: deps.caller,
    model: deps.model,
    conversation_id: conversationId,
    system_instruction: systemInstruction,
    message: input.user_message,
    context: {
      ...callerContext,
      ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
    },
    tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    tool_results: [guardedToolResult],
  });
  if (!guardedCall.ok) {
    const error = guardedCall.error;'''
source, count = guarded_single_pattern.subn(guarded_single_replacement, source, count=1)
assert count == 1, f"guarded single replacement count={count}"
source, count = re.subn(
    r'  let updatedConversationId = conversationId;\n  if \(guardedOutput\.conversation_id !== undefined\) \{\n    updatedConversationId = guardedOutput\.conversation_id;\n  \}',
    '  const guardedOutput = guardedCall.output;\n  const updatedConversationId = guardedCall.conversation_id;',
    source,
    count=1,
)
assert count == 1, f"guarded single conversation update count={count}"

if 'await deps.caller(' in source:
    raise AssertionError("legacy loop still directly invokes deps.caller")
if source.count('invokeRuntimeModelCall({') != 6:
    raise AssertionError(f"expected 6 model boundary calls, got {source.count('invokeRuntimeModelCall({')}")

path.write_text(source)
