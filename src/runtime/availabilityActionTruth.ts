import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export type AvailabilityOutcome =
  | "slots_available"
  | "no_slots"
  | "past_date"
  | "technical_failure"
  | "denied";

export type AvailabilityRequiredNextAction =
  | "choose_slot"
  | "ask_for_alternative_time"
  | "ask_for_future_date"
  | "retry_or_contact_clinic";

export interface AvailabilityActionTruth {
  outcome: AvailabilityOutcome;
  requested_date: string | null;
  requested_time: string | null;
  can_present_slots: boolean;
  required_next_action: AvailabilityRequiredNextAction;
  allowed_slot_starts: string[];
}

function extractAllowedSlotStarts(result: RuntimeAgentToolResult): string[] {
  const data = result.data as { slots?: unknown[] } | null | undefined;
  if (!Array.isArray(data?.slots)) return [];
  const starts: string[] = [];
  for (const s of data!.slots!) {
    if (s && typeof s === "object") {
      const raw = s as { starts_at?: unknown };
      if (typeof raw.starts_at === "string") starts.push(raw.starts_at);
    }
  }
  return starts;
}

export function buildAvailabilityActionTruth(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AvailabilityActionTruth | null {
  const request = requests.find((r) => r.tool === "availability.check");
  if (!request) return null;

  // Pair by call_id when available; fall back to the first availability result.
  const result = request.call_id
    ? results.find((r) => r.tool === "availability.check" && r.call_id === request.call_id)
    : results.find((r) => r.tool === "availability.check");
  if (!result) return null;

  const requested_date =
    typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null;
  const requested_time =
    typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null;

  if (result.status === "denied") {
    return {
      outcome: "denied",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
      allowed_slot_starts: [],
    };
  }

  if (result.status === "failed") {
    if (result.error?.code === "availability_past_date") {
      return {
        outcome: "past_date",
        requested_date,
        requested_time,
        can_present_slots: false,
        required_next_action: "ask_for_future_date",
        allowed_slot_starts: [],
      };
    }
    return {
      outcome: "technical_failure",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
      allowed_slot_starts: [],
    };
  }

  // success
  const allowed_slot_starts = extractAllowedSlotStarts(result);
  if (allowed_slot_starts.length > 0) {
    return {
      outcome: "slots_available",
      requested_date,
      requested_time,
      can_present_slots: true,
      required_next_action: "choose_slot",
      allowed_slot_starts,
    };
  }
  return {
    outcome: "no_slots",
    requested_date,
    requested_time,
    can_present_slots: false,
    required_next_action: "ask_for_alternative_time",
    allowed_slot_starts: [],
  };
}
