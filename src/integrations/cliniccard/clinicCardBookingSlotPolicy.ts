import {
  isDateInsideAvailabilityPolicy,
  loadClinicCardAvailabilityPolicy,
} from "./clinicCardAvailabilityPolicy.ts";

export type ClinicCardBookingSlotPolicyResolution =
  | {
      ok: true;
      time_end: string;
      duration_minutes: number;
    }
  | {
      ok: false;
      failure: "policy_unavailable" | "slot_not_allowed";
      reason: string;
    };

function timeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToHHMM(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Revalidates one booking slot against the same operator-confirmed static policy
 * used by availability.check. This runs on every booking.apply invocation, so an
 * offered slot is never sufficient authority by itself.
 */
export function resolveClinicCardBookingSlotPolicy(
  env: Record<string, string | undefined> | undefined,
  date: string,
  timeStart: string,
): ClinicCardBookingSlotPolicyResolution {
  const policyResult = loadClinicCardAvailabilityPolicy(env);
  if (!policyResult.ok) {
    return {
      ok: false,
      failure: "policy_unavailable",
      reason: `${policyResult.error.code}: ${policyResult.error.message}`,
    };
  }

  const policy = policyResult.data;
  if (!isDateInsideAvailabilityPolicy(date, policy)) {
    return {
      ok: false,
      failure: "slot_not_allowed",
      reason: `${date} is not an open clinic date in the confirmed availability policy`,
    };
  }

  const startMinutes = timeToMinutes(timeStart);
  const policyStartMinutes = timeToMinutes(policy.working_hours_start);
  const policyEndMinutes = timeToMinutes(policy.working_hours_end);
  if (startMinutes === null || policyStartMinutes === null || policyEndMinutes === null) {
    return {
      ok: false,
      failure: "slot_not_allowed",
      reason: `slot start ${JSON.stringify(timeStart)} is not a valid strict HH:MM time`,
    };
  }

  const endMinutes = startMinutes + policy.slot_duration_minutes;
  if (startMinutes < policyStartMinutes || endMinutes > policyEndMinutes) {
    return {
      ok: false,
      failure: "slot_not_allowed",
      reason: `slot ${date} ${timeStart} with ${policy.slot_duration_minutes} minute duration falls outside confirmed working hours ${policy.working_hours_start}-${policy.working_hours_end}`,
    };
  }

  if ((startMinutes - policyStartMinutes) % policy.slot_duration_minutes !== 0) {
    return {
      ok: false,
      failure: "slot_not_allowed",
      reason: `slot ${date} ${timeStart} is not aligned to the confirmed ${policy.slot_duration_minutes} minute slot grid starting at ${policy.working_hours_start}`,
    };
  }

  return {
    ok: true,
    time_end: minutesToHHMM(endMinutes),
    duration_minutes: policy.slot_duration_minutes,
  };
}
