export interface ClinicCardErrorLike {
  code: string;
  message: string;
}

export type ClinicCardOperationKind = "read" | "write";
export type ClinicCardOutcomeCertainty = "known_failed" | "unknown";

export interface ClinicCardFailureDisposition {
  transient: boolean;
  safe_to_retry: boolean;
  outcome: ClinicCardOutcomeCertainty;
}

function httpStatusFromMessage(message: string): number | null {
  const match = message.match(/^HTTP\s+(\d{3})(?:\s|:|$)/i);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Classifies an external ClinicCard failure by what the Runtime may safely infer.
 *
 * Reads have no side effect, so transient transport/server failures may be retried.
 * Writes are different: after a timeout, transport failure, or transient HTTP error,
 * ClinicCard may have committed the mutation even though Runtime did not receive the
 * response. Such writes are outcome-unknown and must be reconciled before any retry.
 */
export function classifyClinicCardFailure(
  error: ClinicCardErrorLike,
  operation: ClinicCardOperationKind,
): ClinicCardFailureDisposition {
  const code = error.code.trim().toLowerCase();

  if (code === "cliniccard_validation_error") {
    return { transient: false, safe_to_retry: false, outcome: "known_failed" };
  }

  if (code === "cliniccard_api_error") {
    return { transient: false, safe_to_retry: false, outcome: "known_failed" };
  }

  if (code === "cliniccard_http_error") {
    const status = httpStatusFromMessage(error.message);
    const transient = status !== null && isTransientHttpStatus(status);
    if (operation === "read") {
      return { transient, safe_to_retry: transient, outcome: "known_failed" };
    }
    return {
      transient,
      safe_to_retry: false,
      outcome: transient ? "unknown" : "known_failed",
    };
  }

  if (code === "cliniccard_timeout" || code === "cliniccard_request_failed") {
    if (operation === "read") {
      return { transient: true, safe_to_retry: true, outcome: "known_failed" };
    }
    return { transient: true, safe_to_retry: false, outcome: "unknown" };
  }

  // Unknown read errors are not declared retryable without evidence. Unknown write
  // errors fail on the conservative side because a side effect may already exist.
  return operation === "write"
    ? { transient: false, safe_to_retry: false, outcome: "unknown" }
    : { transient: false, safe_to_retry: false, outcome: "known_failed" };
}
