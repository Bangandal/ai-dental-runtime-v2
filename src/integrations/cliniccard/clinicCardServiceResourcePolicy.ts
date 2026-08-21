import type { ClinicCardResult } from "./clinicCardTypes.ts";

export interface ClinicCardServiceResourceRule {
  service_key: string;
  aliases: readonly string[];
  doctor_id: number;
  cabinet_id: number;
  duration_minutes: number;
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

const RULES_ENV = "CLINICCARD_SERVICE_RESOURCE_RULES_JSON";
const CONFIRMED_ENV = "CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED";

function normalizeService(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function fail(code: string, message: string): ClinicCardResult<never> {
  return { ok: false, error: { code, message } };
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
    });
  }

  return { ok: true, data: { rules } };
}

export function resolveClinicCardServiceResource(
  env: Record<string, string | undefined> | undefined,
  serviceInterest: string | null | undefined,
): ClinicCardServiceResourceResolution {
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

  const rule = matchingRules[0];
  return {
    ok: true,
    source: "operator_confirmed_config",
    service_key: rule.service_key,
    doctor_id: rule.doctor_id,
    cabinet_id: rule.cabinet_id,
    duration_minutes: rule.duration_minutes,
  };
}
