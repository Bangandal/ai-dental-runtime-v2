from pathlib import Path

loop_path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
workflow_path = Path(".github/workflows/runtime-tests.yml")
script_path = Path(__file__)
text = loop_path.read_text()

old_import = 'import { shouldInterceptMissingPhoneBeforeBookingApply, shouldInterceptNoSlotsBeforeBookingApply, bookingApplyArgsMissingSlot, getMissingBookingApplyNameFields, bookingApplyArgsMissingService, shouldInterceptInvalidSlotDateTime, shouldInterceptMissingSlotProof } from "./bookingApplyPreflight.ts";'
new_import = 'import { shouldInterceptNoSlotsBeforeBookingApply } from "./bookingApplyPreflight.ts";\nimport { evaluateBookingApplyPreflight } from "./bookingApplyPreflightDecision.ts";'
if old_import not in text:
    raise SystemExit("R2e import marker not found")
text = text.replace(old_import, new_import, 1)

round1_start = '      // Guard I (round 1) — pending typed phone: fires right after subject resolution, before\n'
round1_end = '      // When Guard S fired, booking.apply was blocked in round-1 (not executed) — no resolution.\n'
start = text.index(round1_start)
end = text.index(round1_end, start)
round1_replacement = '''      // Shared booking business preflight (round 1) — execution patient is already frozen.\n      // Guard priority lives in bookingApplyPreflightDecision, not in this transport loop.\n      if (!guardSFired && bookingApplyRound1) {\n        const round1Preflight = evaluateBookingApplyPreflight({\n          round: 1,\n          pendingBookingApply: bookingApplyRound1,\n          pendingToolRequests: toolRequests,\n          pendingTypedPhone: Boolean(effectiveBookingSubjects?.pending_typed_phone),\n          hasBookingPhone: hasSubjectOrContactPhone(effectiveInput, round1ExecutionSubjectId),\n          activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,\n          selectedSlot: bookingProcessState.selected_slot,\n          selectedSlotProof: bookingProcessState.selected_slot_proof,\n          includeInvalidSlotGuard: false,\n          timezone,\n          now: turnNow,\n        });\n        if (round1Preflight.outcome === "block") {\n          debug.reason = round1Preflight.debug_reason;\n          if (round1Preflight.past_time_detail) debug.past_time_detail = round1Preflight.past_time_detail;\n          if (round1Preflight.missing_fields) debug.missing_fields = round1Preflight.missing_fields;\n          return await finalizeBlockedBookingApplyWithToolOutput({\n            pendingBookingApply: bookingApplyRound1,\n            guardedData: round1Preflight.guarded_data,\n            previousToolResults: [],\n            toolRequests: processedToolRequests,\n            conversationId,\n            systemInstruction,\n            callerContext,\n            input,\n            debug,\n            deps,\n            execution_subject_id: round1ExecutionSubjectId,\n            booking_subjects_after_resolution: bootstrappedRegistry,\n          });\n        }\n      }\n\n'''
text = text[:start] + round1_replacement + text[end:]

round2_start = '        if (pendingBookingApply) {\n          // 7. Guard I (round 2): pending typed phone fires right after subject resolution,\n'
round2_end = '          debug.reason = "booking_apply_executed_after_round2_request";\n'
start = text.index(round2_start)
end = text.index(round2_end, start)
round2_replacement = '''        // Shared booking business preflight (round 2). No-slots and subject resolution\n        // have already run; this owns pending-phone → time/slot proof → phone → name/service.\n        if (pendingBookingApply) {\n          const round2Preflight = evaluateBookingApplyPreflight({\n            round: 2,\n            pendingBookingApply,\n            pendingToolRequests: secondOutput.tool_requests,\n            pendingTypedPhone: Boolean(effectiveBookingSubjects?.pending_typed_phone),\n            hasBookingPhone: hasSubjectOrContactPhone(effectiveInput, round2ExecutionSubjectId),\n            activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,\n            selectedSlot: bookingProcessState.selected_slot,\n            selectedSlotProof: bookingProcessState.selected_slot_proof,\n            includeInvalidSlotGuard: true,\n            timezone,\n            now: turnNow,\n          });\n          if (round2Preflight.outcome === "block") {\n            debug.reason = round2Preflight.debug_reason;\n            if (round2Preflight.past_time_detail) debug.past_time_detail = round2Preflight.past_time_detail;\n            if (round2Preflight.missing_fields) debug.missing_fields = round2Preflight.missing_fields;\n            return await finalizeBlockedBookingApplyWithToolOutput({\n              pendingBookingApply,\n              guardedData: round2Preflight.guarded_data,\n              previousToolResults: toolResults,\n              toolRequests: processedToolRequests,\n              conversationId,\n              systemInstruction,\n              callerContext,\n              input,\n              debug,\n              deps,\n              execution_subject_id: round2ExecutionSubjectId,\n              booking_subjects_after_resolution: bootstrappedRegistry,\n            });\n          }\n\n'''
text = text[:start] + round2_replacement + text[end:]

loop_path.write_text(text)

workflow_path.write_text('''name: Runtime tests\n\non:\n  pull_request:\n  push:\n    branches:\n      - ai-dental-frontdesk-core\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: runtime-tests-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  test:\n    name: npm test\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n\n      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n\n      - name: Install dependencies\n        run: npm ci\n\n      - name: Run full test suite\n        shell: bash\n        run: |\n          set -o pipefail\n          npm test 2>&1 | tee test-output.txt\n\n      - name: Upload test output\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: runtime-test-output\n          path: test-output.txt\n          if-no-files-found: error\n''')

script_path.unlink()
print("R2e loop migration applied; workflow restored; migration script removed")
