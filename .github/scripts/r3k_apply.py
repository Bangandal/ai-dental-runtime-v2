from pathlib import Path
import re

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

source, count = re.subn(
    r'import \{ executeBookingSelectSlot, executeBookingSelectSlotBatch, type BookingSelectSlotSuccessData \} from "\.\/bookingSelectSlot\.ts";',
    'import { executeBookingSelectSlotBatch } from "./bookingSelectSlot.ts";',
    source,
)
assert count == 1, f"import replacement count={count}"

guard_s = '''        const round1GuardSSelection = executeBookingSelectSlotBatch({
          requests: round1SelectSlotRequests,
          activeEvidence: priorProcessState?.active_availability_evidence ?? null,
          subjects: effectiveBookingSubjects?.subjects ?? null,
        });
        toolResults.push(...round1GuardSSelection.tool_results);
        const srSuccessData = round1GuardSSelection.success_data;

'''
source, count = re.subn(
    r'        const srAmbiguous = round1SelectSlotRequests\.length > 1;\n'
    r'        let srSuccessData: BookingSelectSlotSuccessData \| null = null;\n\n'
    r'        for \(const req of round1SelectSlotRequests\) \{.*?'
    r'        \}\n\n'
    r'        // Close the same-round booking\.apply call ID with a blocked result\.',
    guard_s + '        // Close the same-round booking.apply call ID with a blocked result.',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"guard S replacement count={count}"

normal_setup = '''        // Resolve booking.select_slot through the same round-agnostic batch helper used
        // by later model calls. Results are inserted in original request order below.
        const round1SlotSelection = executeBookingSelectSlotBatch({
          requests: toolRequests,
          activeEvidence: priorProcessState?.active_availability_evidence ?? null,
          subjects: effectiveBookingSubjects?.subjects ?? null,
        });
        let nextSelectSlotResultIndex = 0;

'''
source, count = re.subn(
    r'        // Track the first successful booking\.select_slot result this turn\.\n'
    r'        let selectSlotSuccessData: BookingSelectSlotSuccessData \| null = null;\n'
    r'        // Multiple booking\.select_slot calls in one round → ambiguous → no proof created\.\n'
    r'        const selectSlotRequestCount = toolRequests\.filter\(\(r\) => r\.tool === "booking\.select_slot"\)\.length;\n'
    r'        const selectSlotAmbiguous = selectSlotRequestCount > 1;\n\n',
    normal_setup,
    source,
    count=1,
)
assert count == 1, f"normal setup replacement count={count}"

normal_select = '''          if (request.tool === "booking.select_slot") {
            const selectToolResult = round1SlotSelection.tool_results[nextSelectSlotResultIndex++];
            if (selectToolResult) {
              toolResults.push(selectToolResult);
            }
            continue;
          }

'''
source, count = re.subn(
    r'          if \(request\.tool === "booking\.select_slot"\) \{.*?'
    r'          \}\n\n'
    r'          const planner = buildPlannerFromAgentToolRequest\(request\);',
    normal_select + '          const planner = buildPlannerFromAgentToolRequest(request);',
    source,
    count=1,
    flags=re.S,
)
assert count == 1, f"normal select replacement count={count}"

source = source.replace('          selectSlotData: selectSlotSuccessData,', '          selectSlotData: round1SlotSelection.success_data,', 1)
source = source.replace('          selectSlotAttemptedThisTurn: selectSlotRequestCount > 0,', '          selectSlotAttemptedThisTurn: round1SlotSelection.attempted,', 1)

if 'executeBookingSelectSlot(' in source:
    raise AssertionError("legacy loop still directly calls executeBookingSelectSlot")

path.write_text(source)
