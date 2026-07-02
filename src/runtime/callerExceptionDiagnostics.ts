import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export type CallerExceptionStage = "first_call" | "second_call" | "forced_finalization";

export interface CallerExceptionDiagnostics {
  stage: CallerExceptionStage;
  error_name: string | null;
  error_code: string | number | null;
  request_id: string | null;
  message: string;
  locale: string | null;
  has_conversation_id: boolean;
  had_tool_results: boolean;
  had_booking_apply_action_truth: boolean;
  tool_names: string[];
}

const MAX_MESSAGE_LENGTH = 300;
// Redact opaque secret-shaped substrings (API keys, bearer tokens, long hex/base64
// blobs) and phone-number-shaped substrings before anything derived from a caught
// error is ever stored in debug output — debug is internal, but never a dumping
// ground for patient PII or credentials.
const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+\S+/gi,
  /[A-Za-z0-9_-]{32,}/g,
  /\+\d{6,15}/g,
];

export function sanitizeErrorMessage(raw: string): string {
  let sanitized = raw;
  for (const pattern of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.length > MAX_MESSAGE_LENGTH ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH)}…` : sanitized;
}

function readErrorField(err: Record<string, unknown> | null, keys: string[]): string | number | null {
  if (!err) return null;
  for (const key of keys) {
    const value = err[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return null;
}

export interface CallerExceptionContext {
  stage: CallerExceptionStage;
  locale?: string | null;
  conversationId: string | null;
  toolResults?: RuntimeAgentToolResult[];
  bookingApplyActionTruth?: unknown;
}

/** Builds a safe, structured, size-bounded diagnostic snapshot of a caught caller
 * exception — never the raw error object, never tool arguments, never patient text. */
export function buildCallerExceptionDiagnostics(
  error: unknown,
  ctx: CallerExceptionContext,
): CallerExceptionDiagnostics {
  const errRecord = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const rawMessage = error instanceof Error ? error.message : String(error);

  return {
    stage: ctx.stage,
    error_name: error instanceof Error ? error.name : null,
    error_code: readErrorField(errRecord, ["code", "status", "type", "status_code", "statusCode"]),
    request_id: (readErrorField(errRecord, ["request_id", "requestId"]) as string | null) ?? null,
    message: sanitizeErrorMessage(rawMessage),
    locale: ctx.locale ?? null,
    has_conversation_id: ctx.conversationId !== null,
    had_tool_results: Boolean(ctx.toolResults && ctx.toolResults.length > 0),
    had_booking_apply_action_truth: Boolean(ctx.bookingApplyActionTruth),
    tool_names: (ctx.toolResults ?? []).map((r) => r.tool),
  };
}
