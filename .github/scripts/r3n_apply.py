from pathlib import Path

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

old_import = 'import { buildModelVisibleCallerContext } from "./modelVisibleCallerContext.ts";'
new_import = 'import { buildModelVisibleCallerContext, composeRuntimeModelContext } from "./modelVisibleCallerContext.ts";'
assert source.count(old_import) == 1
source = source.replace(old_import, new_import, 1)

old = '        context: { ...callerContext, booking_process_state: firstCallVisibleState },'
new = '        context: composeRuntimeModelContext(callerContext, { booking_process_state: firstCallVisibleState }),' 
assert source.count(old) == 1
source = source.replace(old, new, 1)

old = '''      const secondCallContext = {
        ...callerContext,
        ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
        ...(availabilityActionTruth ? { availability_action_truth: availabilityActionTruth } : {}),
        ...(availabilityPresentationTruth ? { availability_presentation_truth: availabilityPresentationTruth } : {}),
        ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
        booking_process_state: secondCallVisibleState,
      };'''
new = '''      const secondCallContext = composeRuntimeModelContext(callerContext, {
        booking_apply_action_truth: bookingActionTruth,
        availability_action_truth: availabilityActionTruth,
        availability_presentation_truth: availabilityPresentationTruth,
        appointment_display_truth: appointmentDisplayTruth,
        booking_process_state: secondCallVisibleState,
      });'''
assert source.count(old) == 1
source = source.replace(old, new, 1)

old = '''            context: {
              ...callerContext,
              resolved_context: allResults,
              ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
              ...(bookingApplyDisplayTruth ? { appointment_display_truth: bookingApplyDisplayTruth } : {}),
            },'''
new = '''            context: composeRuntimeModelContext(callerContext, {
              resolved_context: allResults,
              booking_apply_action_truth: bookingApplyTruth,
              appointment_display_truth: bookingApplyDisplayTruth,
            }),'''
assert source.count(old) == 1
source = source.replace(old, new, 1)

old = '''            context: {
              ...callerContext,
              resolved_context: toolResults,
              ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
              ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
            },'''
new = '''            context: composeRuntimeModelContext(callerContext, {
              resolved_context: toolResults,
              booking_apply_action_truth: bookingActionTruth,
              appointment_display_truth: appointmentDisplayTruth,
            }),'''
assert source.count(old) == 1
source = source.replace(old, new, 1)

old = '''    context: {
      ...callerContext,
      ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
    },'''
new = '''    context: composeRuntimeModelContext(callerContext, {
      booking_apply_action_truth: bookingApplyTruth,
    }),'''
assert source.count(old) == 2, f"expected two guarded context blocks, got {source.count(old)}"
source = source.replace(old, new, 2)

count = source.count('composeRuntimeModelContext(')
if count != 6:
    raise AssertionError(f"expected 6 composed model contexts, got {count}")

path.write_text(source)
