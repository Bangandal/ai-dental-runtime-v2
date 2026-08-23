import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import type { RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import { getTodayInTimezone } from "./bookingPreflight.ts";

export const AGENT_FIRST_UNDATED_AVAILABILITY_OFFSET_DAYS = 2;

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Product default for an availability request where the patient did not name any date.
 *
 * The model deliberately does not do calendar arithmetic here. In agent-first mode it may
 * call availability.check without requested_date; Runtime injects today + 2 clinic-calendar
 * days before any policy, availability evidence, truth, or ClinicCard execution sees the
 * request. Explicit patient dates are never rewritten. Legacy mode is byte-for-byte semantic
 * compatible: requests are returned unchanged.
 */
export function applyAgentFirstUndatedAvailabilityDefault(params: {
  requests: RuntimeAgentToolRequest[];
  now: Date;
  timezone: string;
}): RuntimeAgentToolRequest[] {
  if (!isAgentFirstRuntimeEnabled()) return params.requests;

  const today = getTodayInTimezone(params.now, params.timezone);
  const defaultDate = addCalendarDays(today, AGENT_FIRST_UNDATED_AVAILABILITY_OFFSET_DAYS);
  let changed = false;

  const normalized = params.requests.map((request) => {
    if (request.tool !== "availability.check") return request;

    const requestedDate = request.arguments.requested_date;
    if (typeof requestedDate === "string" && requestedDate.trim().length > 0) return request;

    changed = true;
    return {
      ...request,
      arguments: {
        ...request.arguments,
        requested_date: defaultDate,
      },
    };
  });

  return changed ? normalized : params.requests;
}
