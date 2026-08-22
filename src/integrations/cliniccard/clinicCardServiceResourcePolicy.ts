import type { ClinicCardResult } from "./clinicCardTypes.ts";
import { getIsoWeekday } from "./clinicCardAvailabilityPolicy.ts";

export interface ClinicCardServiceSchedule {
  working_days: readonly number[];
  working_hours_start: string;
  working_hours_end: string;
  closed_dates: ReadonlySet<string>;
}

export interface ClinicCardServiceResourceRule {
  service_key: string;
  aliases: readonly string[];
  doctor_id: number;
  cabinet_id: number;
  duration_minutes: number;
  /**
   * Operator-confirmed schedule for the concrete provider/resource used by this
   * service. Optional at policy-load time for backwards-compatible inspection,
   * but availability and live booking fail closed when it is absent.
   */
  availability?: ClinicCardServiceSchedule;
}

export interface ClinicCardServiceResourcePolicy {
  rules: readonly ClinicCardServiceResourceRule[];
}

export type ClinicCardServiceResourceResolution =
  | {
      ok: true;
      source: "operator_confirmed_config";
      service_key: string;
      doctor_id: number;
      cabinet_id: number;
      duration_minutes: number;
    }
  | {
      ok: false;
      failure: "policy_unavailable" | "service_missing" | "service_unmapped";
      reason: string;
    };

export type ClinicCardServiceScheduleResolution =
  | {
      ok: true;
      source: "operator_confirmed_config";
      service_key: string;
      schedule: ClinicCardServiceSchedule;
    }
  | {
      ok: false;
      failure: "policy_unavailable" | "service_missing" | "service_unmapped" | "schedule_unavailable";
      reason: string;
    };

const RULES_ENV = "CLINICCARD_SERVICE_RESOURCE_RULES_JSON";
const CONFIRMED_ENV = "CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED";
const HHMM_RE = /^(\d{2}):(\d{2})$/;

function normalizeService(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function fail(code: string, message: string): ClinicCardResult<never> {
  return { ok: false, error: { code, message } };
}

function parseStrictHHMM(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(HHMM_RE);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function parseOptionalServiceSchedule(
  value: unknown,
  ruleIndex: number,
): ClinicCardResult<ClinicCardServiceSchedule | null> {
  if (value === undefined || value === null) return { ok: true, data: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `service rule ${ruleIndex} availability must be an object`,
    );
  }

  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.working_days) || raw.working_days.length === 0) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `service rule ${ruleIndex} availability.working_days must be a non-empty array of ISO weekdays 1-7`,
    );
  }
  const workingDays = raw.working_days.map((day) => Number(day));
  if (
    workingDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(workingDays).size !== workingDays.length
  ) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `service rule ${ruleIndex} availability.working_days must contain unique ISO weekdays 1-7`,
    );
  }

  const workingHoursStart = parseStrictHHMM(raw.working_hours_start);
  const workingHoursEnd = parseStrictHHMM(raw.working_hours_end);
  if (!workingHoursStart || !workingHoursEnd || timeToMinutes(workingHoursEnd) <= timeToMinutes(workingHoursStart)) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `service rule ${ruleIndex} availability requires valid working_hours_start/working_hours_end with end later than start`,
    );
  }

  const closedDatesRaw = raw.closed_dates ?? [];
  if (!Array.isArray(closedDatesRaw) || closedDatesRaw.some((date) => typeof date !== "string" || getIsoWeekday(date) === null)) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `service rule ${ruleIndex} availability.closed_dates must be an array of valid YYYY-MM-DD dates`,
    );
  }

  return {
    ok: true,
    data: {
      working_days: workingDays,
      working_hours_start: workingHoursStart,
      working_hours_end: workingHoursEnd,
      closed_dates: new Set(closedDatesRaw as string[]),
    },
  };
}

export function loadClinicCardServiceResourcePolicy(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ClinicCardResult<ClinicCardServiceResourcePolicy> {
  if (env[CONFIRMED_ENV]?.trim().toLowerCase() !== "true") {
    return fail(
      "cliniccard_service_resource_policy_missing",
      `${CONFIRMED_ENV}=true is required before a service may authorize provider/resource/duration`,
    );
  }

  const raw = env[RULES_ENV]?.trim();
  if (!raw) {
    return fail(
      "cliniccard_service_resource_policy_missing",
      `${RULES_ENV} is required and must contain at least one operator-confirmed service rule`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("cliniccard_service_resource_policy_invalid", `${RULES_ENV} must be valid JSON`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return fail(
      "cliniccard_service_resource_policy_invalid",
      `${RULES_ENV} must be a non-empty JSON array`,
    );
  }

  const rules: ClinicCardServiceResourceRule[] = [];
  const aliasOwners = new Map<string, string>();

  for (let index = 0; index < parsed.length; index += 1) {
    const rawRule = parsed[index];
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      return fail("cliniccard_service_resource_policy_invalid", `service rule ${index} must be an object`);
    }

    const rule = rawRule as Record<string, unknown>;
    const serviceKeyRaw = typeof rule.service_key === "string" ? rule.service_key.trim() : "";
    const doctorId = positiveInteger(rule.doctor_id);
    const cabinetId = positiveInteger(rule.cabinet_id);
    const durationMinutes = positiveInteger(rule.duration_minutes);

    if (!serviceKeyRaw || doctorId === null || cabinetId === null || durationMinutes === null) {
      return fail(
        "cliniccard_service_resource_policy_invalid",
        `service rule ${index} requires non-empty service_key and positive integer doctor_id, cabinet_id, duration_minutes`,
      );
    }

    const aliasesRaw = rule.aliases ?? [];
    if (!Array.isArray(aliasesRaw) || aliasesRaw.some((alias) => typeof alias !== "string" || alias.trim().length === 0)) {
      return fail(
        "cliniccard_service_resource_policy_invalid",
        `service rule ${index} aliases must be an array of non-empty strings`,
      );
    }

    const scheduleResult = parseOptionalServiceSchedule(rule.availability, index);
    if (!scheduleResult.ok) return scheduleResult;

    const normalizedAliases = Array.from(new Set([
      normalizeService(serviceKeyRaw),
      ...aliasesRaw.map((alias) => normalizeService(alias as string)),
    ]));

    for (const alias of normalizedAliases) {
      const existingOwner = aliasOwners.get(alias);
      if (existingOwner && existingOwner !== serviceKeyRaw) {
        return fail(
          "cliniccard_service_resource_policy_invalid",
          `service alias ${JSON.stringify(alias)} is assigned to both ${JSON.stringify(existingOwner)} and ${JSON.stringify(serviceKeyRaw)}`,
        );
      }
      aliasOwners.set(alias, serviceKeyRaw);
    }

    rules.push({
      service_key: serviceKeyRaw,
      aliases: normalizedAliases,
      doctor_id: doctorId,
      cabinet_id: cabinetId,
      duration_minutes: durationMinutes,
      ...(scheduleResult.data ? { availability: scheduleResult.data } : {}),
    });
  }

  return { ok: true, data: { rules } };
}

function findMatchingServiceRule(
  env: Record<string, string | undefined> | undefined,
  serviceInterest: string | null | undefined,
):
  | { ok: true; rule: ClinicCardServiceResourceRule }
  | { ok: false; failure: "policy_unavailable" | "service_missing" | "service_unmapped"; reason: string } {
  const service = typeof serviceInterest === "string" ? normalizeService(serviceInterest) : "";
  if (!service) {
    return {
      ok: false,
      failure: "service_missing",
      reason: "service_interest is required before provider/resource/duration can be resolved",
    };
  }

  const policyResult = loadClinicCardServiceResourcePolicy(env);
  if (!policyResult.ok) {
    return {
      ok: false,
      failure: "policy_unavailable",
      reason: `${policyResult.error.code}: ${policyResult.error.message}`,
    };
  }

  const matchingRules = policyResult.data.rules.filter((rule) => rule.aliases.includes(service));
  if (matchingRules.length !== 1) {
    return {
      ok: false,
      failure: "service_unmapped",
      reason: `service ${JSON.stringify(serviceInterest)} is not mapped by the confirmed service/resource policy`,
    };
  }

  return { ok: true, rule: matchingRules[0] };
}

export function resolveClinicCardServiceResource(
  env: Record<string, string | undefined> | undefined,
  serviceInterest: string | null | undefined,
): ClinicCardServiceResourceResolution {
  const matched = findMatchingServiceRule(env, serviceInterest);
  if (!matched.ok) return matched;

  return {
    ok: true,
    source: "operator_confirmed_config",
    service_key: matched.rule.service_key,
    doctor_id: matched.rule.doctor_id,
    cabinet_id: matched.rule.cabinet_id,
    duration_minutes: matched.rule.duration_minutes,
  };
}

export function resolveClinicCardServiceSchedule(
  env: Record<string, string | undefined> | undefined,
  serviceInterest: string | null | undefined,
): ClinicCardServiceScheduleResolution {
  const matched = findMatchingServiceRule(env, serviceInterest);
  if (!matched.ok) return matched;
  if (!matched.rule.availability) {
    return {
      ok: false,
      failure: "schedule_unavailable",
      reason: `service ${JSON.stringify(serviceInterest)} has no operator-confirmed provider availability schedule in ${RULES_ENV}`,
    };
  }

  return {
    ok: true,
    source: "operator_confirmed_config",
    service_key: matched.rule.service_key,
    schedule: matched.rule.availability,
  };
}

export function isDateInsideClinicCardServiceSchedule(
  date: string,
  schedule: ClinicCardServiceSchedule,
): boolean {
  const weekday = getIsoWeekday(date);
  if (weekday === null) return false;
  return schedule.working_days.includes(weekday) && !schedule.closed_dates.has(date);
}

export function validateClinicCardServiceSlot(
  date: string,
  timeStart: string,
  timeEnd: string,
  schedule: ClinicCardServiceSchedule,
): { ok: true } | { ok: false; reason: string } {
  if (!isDateInsideClinicCardServiceSchedule(date, schedule)) {
    return {
      ok: false,
      reason: `${date} is outside the confirmed provider schedule for this service`,
    };
  }

  const startMinutes = timeToMinutes(timeStart);
  const endMinutes = timeToMinutes(timeEnd);
  const scheduleStart = timeToMinutes(schedule.working_hours_start);
  const scheduleEnd = timeToMinutes(schedule.working_hours_end);
  if (startMinutes < scheduleStart || endMinutes > scheduleEnd) {
    return {
      ok: false,
      reason: `slot ${date} ${timeStart}-${timeEnd} falls outside confirmed provider hours ${schedule.working_hours_start}-${schedule.working_hours_end}`,
    };
  }

  return { ok: true };
}
