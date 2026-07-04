import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export interface AvailabilityPresentationTruth {
  must_list_exact_slots_only: true;
  must_not_summarize_ranges: true;
  max_slots_to_present: 5;
  allowed_slot_starts: string[];
}

function extractHHMM(startsAt: unknown): string | null {
  if (typeof startsAt !== "string") return null;
  const match = startsAt.match(/T(\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : null;
}

export function buildAvailabilityPresentationTruth(
  toolResults: RuntimeAgentToolResult[]
): AvailabilityPresentationTruth | null {
  const successfulAvailResults = toolResults.filter(
    (r) => r.tool === "availability.check" && r.status === "success"
  );

  if (successfulAvailResults.length === 0) return null;

  const allowedSlotStarts: string[] = [];

  for (const result of successfulAvailResults) {
    const data = result.data as { slots?: unknown[] } | undefined;
    if (!data || !Array.isArray(data.slots)) continue;

    for (const slot of data.slots) {
      if (slot !== null && typeof slot === "object") {
        const s = slot as { starts_at?: unknown };
        const hhmm = extractHHMM(s.starts_at);
        if (hhmm !== null && !allowedSlotStarts.includes(hhmm)) {
          allowedSlotStarts.push(hhmm);
        }
      }
    }
  }

  return {
    must_list_exact_slots_only: true,
    must_not_summarize_ranges: true,
    max_slots_to_present: 5,
    allowed_slot_starts: allowedSlotStarts,
  };
}
