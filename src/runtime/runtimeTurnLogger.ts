import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface RuntimeTurnLogEvent {
  ts: string;
  status: "ok";
  trace_id: string;
  clinic_id: string;
  contact_id: string;
  case_id: string | null;
  conversation_id: string | null;
  channel: string;
  external_user_id: string | null;
  chat_id: string | null;
  input_text: string;
  final_patient_reply: string;
  tool_results: unknown[];
  side_effects: unknown[];
  debug?: unknown;
  latency_ms: number;
}

export interface TelegramDeliveryLogEvent {
  ts: string;
  trace_id: string;
  ok: boolean;
  retry_count: number;
  error_code?: string;
  error?: string;
}

export interface RuntimeTurnErrorLogEvent {
  ts: string;
  status: "validation_error" | "runtime_error";
  trace_id: string | null;
  error_code: string;
  error_message: string;
  channel: string | null;
  external_user_id: string | null;
  chat_id: string | null;
  input_text: string | null;
  fallback_reply?: string;
  side_effects?: unknown[];
  latency_ms: number;
}

export interface RuntimeTurnLogger {
  logTurn(event: RuntimeTurnLogEvent): Promise<void>;
  logError(event: RuntimeTurnErrorLogEvent): Promise<void>;
  logDelivery(event: TelegramDeliveryLogEvent): Promise<void>;
}

export function createNoopRuntimeTurnLogger(): RuntimeTurnLogger {
  return {
    async logTurn() {},
    async logError() {},
    async logDelivery() {},
  };
}

export interface FileRuntimeTurnLoggerOptions {
  logDir: string;
}

export function createFileRuntimeTurnLogger(options: FileRuntimeTurnLoggerOptions): RuntimeTurnLogger {
  const turnsPath = join(options.logDir, "runtime-turns.jsonl");
  const errorsPath = join(options.logDir, "runtime-errors.jsonl");
  const deliveryPath = join(options.logDir, "runtime-delivery.jsonl");

  return {
    async logTurn(event) {
      await writeJsonLine(turnsPath, event, options.logDir);
    },
    async logError(event) {
      await writeJsonLine(errorsPath, event, options.logDir);
    },
    async logDelivery(event) {
      await writeJsonLine(deliveryPath, event, options.logDir);
    },
  };
}

async function writeJsonLine(path: string, event: RuntimeTurnLogEvent | RuntimeTurnErrorLogEvent | TelegramDeliveryLogEvent, logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}
