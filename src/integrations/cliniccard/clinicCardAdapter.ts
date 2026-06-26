import type {
  ClinicCardConfig,
  ClinicCardCreatePatientInput,
  ClinicCardCreateVisitInput,
  ClinicCardPatient,
  ClinicCardPayment,
  ClinicCardResult,
  ClinicCardVisit,
} from "./clinicCardTypes.ts";

export interface ClinicCardFetch {
  (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

export interface ClinicCardAdapter {
  findPatientByPhone(phone: string): Promise<ClinicCardResult<ClinicCardPatient[]>>;
  createPatient(input: ClinicCardCreatePatientInput): Promise<ClinicCardResult<ClinicCardPatient>>;
  listVisits(from: string, to: string): Promise<ClinicCardResult<ClinicCardVisit[]>>;
  createVisit(input: ClinicCardCreateVisitInput): Promise<ClinicCardResult<ClinicCardVisit>>;
  listPayments(from: string, to: string): Promise<ClinicCardResult<ClinicCardPayment[]>>;
}

export function createClinicCardAdapter(config: ClinicCardConfig, fetchFn?: ClinicCardFetch): ClinicCardAdapter {
  const fetch = fetchFn ?? (globalThis.fetch as unknown as ClinicCardFetch);

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

      const data = await response.json() as T;
      return { ok: true, data };
    } catch (err) {
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
    findPatientByPhone(phone) {
      return request<ClinicCardPatient[]>("GET", `/api/patients?phone=${encodeURIComponent(phone)}`);
    },

    createPatient(input) {
      return request<ClinicCardPatient>("POST", "/api/patients", input);
    },

    listVisits(from, to) {
      return request<ClinicCardVisit[]>(
        "GET",
        `/api/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
    },

    createVisit(input) {
      return request<ClinicCardVisit>("POST", "/api/visits", input);
    },

    listPayments(from, to) {
      return request<ClinicCardPayment[]>(
        "GET",
        `/api/payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
    },
  };
}
