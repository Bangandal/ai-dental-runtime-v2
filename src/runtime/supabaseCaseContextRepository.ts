import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";

export interface CaseSummary {
  case_id: string | null;
  case_type: string | null;
  topic: string | null;
  status: string | null;
  priority: string | null;
}

export interface BookingSummary {
  service_interest: string | null;
  label: string | null;
  status: string | null;
}

export interface AppointmentSummary {
  service_interest: string | null;
  status: string | null;
  start_at: string | null;
}

export interface CaseContextData {
  current_case_id: string | null;
  open_cases: CaseSummary[];
  recent_cases: CaseSummary[];
  active_booking_context: {
    active_hold: BookingSummary | null;
    latest_appointment: AppointmentSummary | null;
  };
}

export interface CaseContextRepository {
  loadCaseContext(input: { clinic_id: string; contact_id: string }): Promise<RuntimeResult<CaseContextData>>;
}

export function createSupabaseCaseContextRepository(deps: { rpc: RpcCaller }): CaseContextRepository {
  return {
    async loadCaseContext(input) {
      const caseResponse = await deps.rpc<any[]>("rpc_get_contact_case_context_v1", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_limit: 5,
      });

      if (caseResponse.error) {
        return { ok: false, error: { code: "case_context_load_failed", message: String((caseResponse.error as any)?.message ?? caseResponse.error), retryable: true } };
      }

      const bookingResponse = await deps.rpc<any[]>("rpc_get_active_booking_context_v1", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
      });

      if (bookingResponse.error) {
        return { ok: false, error: { code: "booking_context_load_failed", message: String((bookingResponse.error as any)?.message ?? bookingResponse.error), retryable: true } };
      }

      const caseRow = Array.isArray(caseResponse.data) ? (caseResponse.data[0] ?? {}) : {};
      const bookingRow = Array.isArray(bookingResponse.data) ? (bookingResponse.data[0] ?? {}) : {};

      const openCases = asCaseList(caseRow.open_cases);
      const recentCases = asCaseList(caseRow.recent_cases);

      return {
        ok: true,
        data: {
          current_case_id: asNullableString(caseRow.current_case_id),
          open_cases: openCases,
          recent_cases: recentCases,
          active_booking_context: {
            active_hold: asBooking(bookingRow.active_hold),
            latest_appointment: asAppointment(bookingRow.latest_appointment),
          },
        },
      };
    },
  };
}

function asCaseList(value: unknown): CaseSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      case_id: asNullableString(row.case_id),
      case_type: asNullableString(row.case_type),
      topic: asNullableString(row.topic),
      status: asNullableString(row.status),
      priority: asNullableString(row.priority),
    };
  });
}

function asBooking(value: unknown): BookingSummary | null {
  const row = asRecord(value);
  if (!Object.keys(row).length) return null;
  return {
    service_interest: asNullableString(row.service_interest),
    label: asNullableString(row.label),
    status: asNullableString(row.status),
  };
}

function asAppointment(value: unknown): AppointmentSummary | null {
  const row = asRecord(value);
  if (!Object.keys(row).length) return null;
  return {
    service_interest: asNullableString(row.service_interest),
    status: asNullableString(row.status),
    start_at: asNullableString(row.start_at),
  };
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
