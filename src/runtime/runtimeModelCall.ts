import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
} from "./openaiRuntimeAgent.ts";

export interface RuntimeAgentCallerInput {
  model: string;
  conversation_id?: string | null;
  system_instruction: string;
  input: {
    message: string;
    context: Record<string, unknown>;
    tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
    tool_results?: RuntimeAgentToolResult[];
  };
}

export type RuntimeAgentCallerOutput =
  | {
      type: "tool_requests";
      conversation_id?: string | null;
      tool_requests: RuntimeAgentToolRequest[];
      usage?: unknown;
    }
  | {
      type: "final_response";
      conversation_id?: string | null;
      final_response: RuntimeAgentFinalResponse;
      usage?: unknown;
    };

export type RuntimeAgentCaller = (input: RuntimeAgentCallerInput) => Promise<RuntimeAgentCallerOutput>;

export type RuntimeModelCallOutcome =
  | {
      ok: true;
      output: RuntimeAgentCallerOutput;
      conversation_id: string | null;
    }
  | {
      ok: false;
      error: unknown;
      conversation_id: string | null;
    };

export interface RuntimeModelRetryPolicy {
  /** Total attempts including the initial request. Defaults to 3. */
  max_attempts?: number;
  /** Delay used when OpenAI does not provide Retry-After. Defaults to 1000 ms. */
  base_delay_ms?: number;
  /** Upper bound for a single wait. Defaults to 8000 ms. */
  max_delay_ms?: number;
  /** Test seam; production uses setTimeout. */
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumericStatus(error: unknown): number | null {
  const obj = asRecord(error);
  if (!obj) return null;
  for (const key of ["status", "statusCode", "status_code"] as const) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readErrorCode(error: unknown): string | null {
  const obj = asRecord(error);
  if (!obj) return null;
  if (typeof obj.code === "string") return obj.code;
  const nested = asRecord(obj.error);
  return typeof nested?.code === "string" ? nested.code : null;
}

function readHeader(error: unknown, name: string): string | null {
  const obj = asRecord(error);
  const headers = obj?.headers;
  if (!headers) return null;

  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get(name);
    return typeof value === "string" ? value : null;
  }

  const record = asRecord(headers);
  if (!record) return null;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof direct === "string" ? direct : null;
}

/**
 * Retry only explicit rate-limit rejection. We deliberately do not retry arbitrary
 * connection/timeout failures here because a request whose outcome is unknown may have
 * been accepted upstream. A 429 is a rejected transport attempt, so replaying the same
 * model call does not duplicate ClinicCard or other external writes.
 */
export function isRuntimeModelRateLimitError(error: unknown): boolean {
  return readNumericStatus(error) === 429 || readErrorCode(error) === "rate_limit_exceeded";
}

function retryAfterMs(error: unknown): number | null {
  const retryAfterMsHeader = readHeader(error, "retry-after-ms");
  if (retryAfterMsHeader !== null) {
    const parsed = Number(retryAfterMsHeader);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfterHeader = readHeader(error, "retry-after");
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }

  return null;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function clampNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Transport-only boundary for one runtime model call.
 *
 * This function deliberately owns no business fallback, booking guard, dirty-memory,
 * or model-output policy. It constructs the caller payload, invokes the caller, resolves
 * the next conversation id, and retries only upstream 429 rejection at this transport seam.
 * The orchestrator still decides what a terminal exception, malformed output, or further
 * tool request means.
 */
export async function invokeRuntimeModelCall(params: {
  caller: RuntimeAgentCaller;
  model: string;
  conversation_id: string | null;
  system_instruction: string;
  message: string;
  context: Record<string, unknown>;
  tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
  tool_results?: RuntimeAgentToolResult[];
  retry_policy?: RuntimeModelRetryPolicy;
}): Promise<RuntimeModelCallOutcome> {
  const {
    caller,
    model,
    conversation_id,
    system_instruction,
    message,
    context,
    tool_definitions,
    tool_results,
  } = params;

  const maxAttempts = clampPositiveInteger(
    params.retry_policy?.max_attempts,
    DEFAULT_MAX_ATTEMPTS,
  );
  const baseDelayMs = clampNonNegative(
    params.retry_policy?.base_delay_ms,
    DEFAULT_BASE_DELAY_MS,
  );
  const maxDelayMs = clampNonNegative(
    params.retry_policy?.max_delay_ms,
    DEFAULT_MAX_DELAY_MS,
  );
  const sleep = params.retry_policy?.sleep ?? defaultSleep;

  const callerInput: RuntimeAgentCallerInput = {
    model,
    conversation_id,
    system_instruction,
    input: {
      message,
      context,
      ...(tool_definitions !== undefined ? { tool_definitions } : {}),
      ...(tool_results !== undefined ? { tool_results } : {}),
    },
  };

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await caller(callerInput);

      return {
        ok: true,
        output,
        conversation_id: output.conversation_id !== undefined
          ? output.conversation_id
          : conversation_id,
      };
    } catch (error) {
      lastError = error;
      const mayRetry = isRuntimeModelRateLimitError(error) && attempt < maxAttempts;
      if (!mayRetry) break;

      const headerDelay = retryAfterMs(error);
      const exponentialDelay = baseDelayMs * (2 ** (attempt - 1));
      const delayMs = Math.min(
        maxDelayMs,
        Math.max(0, headerDelay ?? exponentialDelay),
      );
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    error: lastError,
    conversation_id,
  };
}
