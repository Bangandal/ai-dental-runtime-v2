import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

interface SourceTurn {
  user?: unknown;
}

interface SourceScenario {
  id?: unknown;
  turns?: SourceTurn[];
}

interface RuntimeResponse {
  trace_id?: string;
  reply_text?: string;
  final_patient_reply?: string;
  tool_results?: unknown[];
  side_effects?: unknown[];
  debug?: unknown;
  ui?: unknown;
  error?: unknown;
}

const sourceFile = process.env.SCENARIOS_FILE?.trim() || "./dental_test_v5_logs2.jsonl";
const outputFile = process.env.OUTPUT_FILE?.trim() || "./dental_test_v6_logs.jsonl";
const baseUrl = (process.env.BASE_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "");
const clinicCode = process.env.CLINIC_CODE?.trim() || "clinic_1";
const channel = process.env.TEST_CHANNEL?.trim() || "telegram";
const languageCode = process.env.TEST_LANGUAGE_CODE?.trim() || "";
const apiKey = process.env.RUNTIME_API_KEY?.trim() || "";
const writeTests = process.env.RUN_WRITE_TESTS?.trim() === "1";
const runId = process.env.RUN_ID?.trim() || `v6_${Date.now()}_${randomUUID().slice(0, 8)}`;
const skipBookingCases = new Set(
  (process.env.SKIP_BOOKING_CASES?.trim() || "R02,R03,R04")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function cleanUserTurns(raw: SourceScenario): string[] {
  if (!Array.isArray(raw.turns)) return [];
  return raw.turns.flatMap((turn) => {
    const text = typeof turn?.user === "string" ? turn.user.trim() : "";
    return text ? [text] : [];
  });
}

function scenarioId(raw: SourceScenario, index: number): string {
  const value = typeof raw.id === "string" ? raw.id.trim() : "";
  return value || `CASE_${String(index + 1).padStart(3, "0")}`;
}

function testPhone(index: number): string {
  const suffix = String(100000 + index).slice(-6);
  return `+420700${suffix}`;
}

async function postTurn(input: {
  scenarioId: string;
  externalUserId: string;
  turnIndex: number;
  text: string;
}): Promise<{ status: number; payload: RuntimeResponse }> {
  const messageId = `${runId}:${input.scenarioId}:${input.turnIndex}`;
  const meta: Record<string, unknown> = {
    message_id: messageId,
    first_name: "Regression",
    last_name: input.scenarioId,
  };
  if (languageCode) meta.language_code = languageCode;

  const response = await fetch(`${baseUrl}/runtime/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      clinic_code: clinicCode,
      channel,
      external_user_id: input.externalUserId,
      text: input.text,
      meta,
    }),
  });

  let payload: RuntimeResponse = {};
  try {
    payload = await response.json() as RuntimeResponse;
  } catch {
    payload = { error: { code: "invalid_json_response" } };
  }
  return { status: response.status, payload };
}

async function runScenario(raw: SourceScenario, index: number) {
  const id = scenarioId(raw, index);
  const externalUserId = `${runId}_${id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const originalTurns = cleanUserTurns(raw);
  const plannedTurns = [...originalTurns];
  const bookingProbeEnabled = originalTurns.length > 0 && !skipBookingCases.has(id);

  if (bookingProbeEnabled) {
    plannedTurns.push(
      "Добре, тоді ще хочу записатися на консультацію. Покажіть найближчий вільний час.",
    );
    if (writeTests) {
      plannedTurns.push(
        `Перший запропонований час мені підходить. Запишіть мене. Ім'я Тестовий Пацієнт ${id}. Мій номер ${testPhone(index + 1)}.`,
      );
    }
  }

  const turns: Array<Record<string, unknown>> = [];
  for (let turnIndex = 0; turnIndex < plannedTurns.length; turnIndex += 1) {
    const user = plannedTurns[turnIndex]!;
    const response = await postTurn({
      scenarioId: id,
      externalUserId,
      turnIndex: turnIndex + 1,
      text: user,
    });
    const payload = response.payload;
    turns.push({
      turn: turnIndex + 1,
      phase: turnIndex < originalTurns.length ? "scenario" : "booking_probe",
      user,
      http_status: response.status,
      bot: payload.final_patient_reply ?? payload.reply_text ?? null,
      trace_id: payload.trace_id ?? null,
      tool_results: payload.tool_results ?? [],
      side_effects: payload.side_effects ?? [],
      ui: payload.ui ?? null,
      debug: payload.debug ?? null,
      error: payload.error ?? null,
    });
  }

  return {
    id,
    external_user_id: externalUserId,
    configured_model_hint: process.env.RUNTIME_OPENAI_MODEL?.trim() || null,
    booking_probe: {
      enabled: bookingProbeEnabled,
      write_enabled: writeTests,
      service: "consultation",
      stable_message_ids: true,
    },
    turns,
  };
}

async function main(): Promise<void> {
  const raw = await readFile(sourceFile, "utf8");
  const scenarios = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SourceScenario);

  await writeFile(outputFile, "", "utf8");
  for (let index = 0; index < scenarios.length; index += 1) {
    const result = await runScenario(scenarios[index]!, index);
    await appendFile(outputFile, `${JSON.stringify(result)}\n`, "utf8");
    process.stdout.write(`[${index + 1}/${scenarios.length}] ${result.id}\n`);
  }

  process.stdout.write(
    `done: ${scenarios.length} scenarios -> ${outputFile}; booking writes=${writeTests ? "enabled" : "disabled"}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
