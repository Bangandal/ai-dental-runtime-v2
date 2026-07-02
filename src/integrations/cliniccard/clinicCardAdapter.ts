import type {
  ClinicCardConfig,
  ClinicCardCreatePatientInput,
  ClinicCardCreateVisitInput,
  ClinicCardPatient,
  ClinicCardPayment,
  ClinicCardResult,
  ClinicCardVisit,
  ClinicCardVisitStatus,
} from "./clinicCardTypes.ts";

export interface ClinicCardFetch {
  (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

// Upper bound for a single ClinicCard HTTP request. Without it a hung ClinicCard
// call keeps the whole runtime turn (and the patient) waiting indefinitely.
export const DEFAULT_CLINICCARD_TIMEOUT_MS = 10_000;

export interface ClinicCardAdapterOptions {
  timeoutMs?: number;
}

export interface ClinicCardAdapter {
  findPatientByPhone(phone: string): Promise<ClinicCardResult<ClinicCardPatient[]>>;
  createPatient(input: ClinicCardCreatePatientInput): Promise<ClinicCardResult<ClinicCardPatient>>;
  listVisits(from: string, to: string): Promise<ClinicCardResult<ClinicCardVisit[]>>;
  createVisit(input: ClinicCardCreateVisitInput): Promise<ClinicCardResult<ClinicCardVisit>>;
  listPayments(from: string, to: string): Promise<ClinicCardResult<ClinicCardPayment[]>>;
}

const VALID_VISIT_STATUSES: ReadonlySet<string> = new Set<ClinicCardVisitStatus>([
  "PLANNED",
  "CONFIRMED",
  "VISITED",
]);

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isMissingId(value: unknown): boolean {
  return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
}

function validationError(message: string): ClinicCardResult<never> {
  return { ok: false, error: { code: "cliniccard_validation_error", message } };
}

// ClinicCard API wraps responses in { data: T, result: "ok", error: null } on success
// and { data: null, result: "error", error: "message" } on failure.
// Raw responses (plain arrays, objects without the envelope shape) are returned as-is
// for backward compatibility with mocked fetch responses in tests.
export function unwrapClinicCardResponse<T>(payload: unknown): ClinicCardResult<T> {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "result" in payload &&
    "data" in payload &&
    "error" in payload
  ) {
    const env = payload as { data: unknown; result: unknown; error: unknown };
    if ((env.result === "ok" || env.result === "success") && env.error === null) {
      return { ok: true, data: env.data as T };
    }
    const msg = typeof env.error === "string" && env.error.length > 0
      ? env.error
      : "ClinicCard API returned an error result";
    return { ok: false, error: { code: "cliniccard_api_error", message: msg } };
  }
  return { ok: true, data: payload as T };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function asTimeHHMM(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function asVisitStatus(value: unknown): ClinicCardVisitStatus {
  return typeof value === "string" && VALID_VISIT_STATUSES.has(value)
    ? value as ClinicCardVisitStatus
    : "PLANNED";
}

function splitPatientName(name: string): { firstname: string; lastname: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const firstname = parts.shift() ?? "";
  return { firstname, lastname: parts.join(" ") };
}

function normalizePatient(raw: unknown): ClinicCardResult<ClinicCardPatient> {
  const row = asRecord(raw);
  if (!row) return validationError("ClinicCard patient response must be an object");

  const id = asPositiveNumber(row.id ?? row.patient_id);
  if (id === null) return validationError("ClinicCard patient response missing positive id/patient_id");

  const explicitName = asOptionalString(row.name);
  const firstname = asOptionalString(row.firstname) ?? "";
  const lastname = asOptionalString(row.lastname) ?? "";
  const joinedName = [firstname, lastname].filter(Boolean).join(" ").trim();
  const name = explicitName ?? joinedName;
  if (!name) return validationError("ClinicCard patient response missing name/firstname/lastname");

  return {
    ok: true,
    data: {
      id,
      name,
      phone: asOptionalString(row.phone),
      email: asOptionalString(row.email),
      birth_date: asOptionalString(row.birth_date),
      created_at: asOptionalString(row.created_at),
    },
  };
}

function normalizePatients(raw: unknown): ClinicCardResult<ClinicCardPatient[]> {
  if (!Array.isArray(raw)) return validationError("ClinicCard patients response must be an array");
  const patients: ClinicCardPatient[] = [];
  for (const item of raw) {
    const normalized = normalizePatient(item);
    if (!normalized.ok) return normalized;
    patients.push(normalized.data);
  }
  return { ok: true, data: patients };
}

function normalizeVisit(raw: unknown, fallbackDate?: string): ClinicCardResult<ClinicCardVisit> {
  const row = asRecord(raw);
  if (!row) return validationError("ClinicCard visit response must be an object");

  const id = asPositiveNumber(row.id ?? row.visit_id);
  if (id === null) return validationError("ClinicCard visit response missing positive id/visit_id");

  const patientId = asPositiveNumber(row.patient_id);
  const doctorId = asPositiveNumber(row.doctor_id);
  const cabinetId = asPositiveNumber(row.cabinet_id);
  const date = asOptionalString(row.date ?? row.visit_date) ?? fallbackDate;
  const timeStart = asTimeHHMM(row.time_start ?? row.visit_start ?? row.start_time);
  const timeEnd = asTimeHHMM(row.time_end ?? row.visit_end ?? row.end_time);

  if (doctorId === null) return validationError("ClinicCard visit response missing positive doctor_id");
  if (cabinetId === null) return validationError("ClinicCard visit response missing positive cabinet_id");
  if (!date) return validationError("ClinicCard visit response missing date/visit_date");
  if (!timeStart) return validationError("ClinicCard visit response missing time_start/visit_start");
  if (!timeEnd) return validationError("ClinicCard visit response missing time_end/visit_end");

  return {
    ok: true,
    data: {
      id,
      patient_id: patientId ?? null,
      doctor_id: doctorId,
      cabinet_id: cabinetId,
      date,
      time_start: timeStart,
      time_end: timeEnd,
      status: asVisitStatus(row.status),
      note: asOptionalString(row.note),
    },
  };
}

function normalizeVisits(raw: unknown, fallbackDate?: string): ClinicCardResult<ClinicCardVisit[]> {
  if (!Array.isArray(raw)) return validationError("ClinicCard visits response must be an array");
  const visits: ClinicCardVisit[] = [];
  for (const item of raw) {
    const normalized = normalizeVisit(item, fallbackDate);
    if (!normalized.ok) return normalized;
    visits.push(normalized.data);
  }
  return { ok: true, data: visits };
}

function toClinicCardCreatePatientPayload(input: ClinicCardCreatePatientInput): Record<string, unknown> {
  const { firstname, lastname } = splitPatientName(input.name);
  return {
    firstname,
    lastname,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.email ? { email: input.email } : {}),
  };
}

function toClinicCardCreateVisitPayload(input: ClinicCardCreateVisitInput): Record<string, unknown> {
  return {
    patient_id: input.patient_id,
    doctor_id: input.doctor_id,
    cabinet_id: input.cabinet_id,
    date: input.date,
    visit_start: input.time_start,
    visit_end: input.time_end,
    status: input.status,
    ...(input.note ? { note: input.note } : {}),
  };
}

// phone is intentionally optional for createPatient:
// ClinicCard allows registering a patient by name only (e.g. when booking on behalf
// of a family member whose phone is unknown). The phone can be added after registration.
// See: POST /api/patients — ClinicCard API accepts name without phone.
function validateCreatePatientInput(input: ClinicCardCreatePatientInput): ClinicCardResult<never> | null {
  if (isBlank(input.name)) return validationError("createPatient: name is required and must not be blank");
  return null;
}

function validateCreateVisitInput(input: ClinicCardCreateVisitInput): ClinicCardResult<never> | null {
  if (isMissingId(input.patient_id)) return validationError("createVisit: patient_id must be a positive number");
  if (isMissingId(input.doctor_id)) return validationError("createVisit: doctor_id must be a positive number");
  if (isMissingId(input.cabinet_id)) return validationError("createVisit: cabinet_id must be a positive number");
  if (isBlank(input.date)) return validationError("createVisit: date is required and must not be blank");
  if (isBlank(input.time_start)) return validationError("createVisit: time_start is required and must not be blank");
  if (isBlank(input.time_end)) return validationError("createVisit: time_end is required and must not be blank");
  if (!VALID_VISIT_STATUSES.has(input.status)) {
    return validationError(`createVisit: status must be one of PLANNED, CONFIRMED, VISITED`);
  }
  return null;
}

export function createClinicCardAdapter(
  config: ClinicCardConfig,
  fetchFn?: ClinicCardFetch,
  options?: ClinicCardAdapterOptions,
): ClinicCardAdapter {
  const fetch = fetchFn ?? (globalThis.fetch as unknown as ClinicCardFetch);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLINICCARD_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    return {
      "Token": config.api_token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  // Prevent the real token from appearing in any error message or log output.
  function redactToken(text: string): string {
    if (!config.api_token) return text;
    return text.split(config.api_token).join("[REDACTED]");
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<ClinicCardResult<T>> {
    const url = `${config.api_base_url}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        return {
          ok: false,
          error: {
            code: "cliniccard_http_error",
            message: `HTTP ${response.status}: ${redactToken(raw)}`,
          },
        };
      }

      const json = await response.json();
      const unwrapped = unwrapClinicCardResponse<T>(json);
      if (!unwrapped.ok) {
        return { ok: false, error: { code: unwrapped.error.code, message: redactToken(unwrapped.error.message) } };
      }
      return { ok: true, data: unwrapped.data };
    } catch (err) {
      // AbortSignal.timeout rejections surface as TimeoutError (undici) or AbortError.
      // The timeout message is fixed text — no URL, body, or token can leak through it.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return {
          ok: false,
          error: {
            code: "cliniccard_timeout",
            message: `ClinicCard request timed out after ${timeoutMs}ms`,
          },
        };
      }
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "cliniccard_request_failed",
          message: redactToken(raw),
        },
      };
    }
  }

  return {
    async findPatientByPhone(phone) {
      const result = await request<unknown>("GET", `/api/patients?phone=${encodeURIComponent(phone)}`);
      if (!result.ok) return result;
      return normalizePatients(result.data);
    },

    async createPatient(input) {
      const err = validateCreatePatientInput(input);
      if (err) return err as ClinicCardResult<ClinicCardPatient>;
      const result = await request<unknown>("POST", "/api/patients", toClinicCardCreatePatientPayload(input));
      if (!result.ok) return result;
      return normalizePatient(result.data);
    },

    async listVisits(from, to) {
      const result = await request<unknown>(
        "GET",
        `/api/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (!result.ok) return result;
      return normalizeVisits(result.data, from === to ? from : undefined);
    },

    async createVisit(input) {
      const err = validateCreateVisitInput(input);
      if (err) return err as ClinicCardResult<ClinicCardVisit>;
      const result = await request<unknown>("POST", "/api/visits", toClinicCardCreateVisitPayload(input));
      if (!result.ok) return result;
      return normalizeVisit(result.data, input.date);
    },

    listPayments(from, to) {
      return request<ClinicCardPayment[]>(
        "GET",
        `/api/payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
    },
  };
}
