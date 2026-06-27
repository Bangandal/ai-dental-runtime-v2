import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  FUTURE_RUNTIME_AGENT_TOOLS,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  buildRuntimeAgentSystemInstruction,
  type RuntimeAgentTurnResult,
} from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";

test("RuntimeAgentTurnResult requires final_patient_reply in type examples", () => {
  const result: RuntimeAgentTurnResult = {
    final_patient_reply: "Sure — we have openings tomorrow afternoon.",
    conversation_id: "conv_123",
    tool_requests: [{ tool: "availability.check", arguments: { requested_date: "2026-05-22" } }],
    tool_results: [{ tool: "availability.check", status: "success", data: { slots: [] } }],
    debug: { trace_id: "trace_1" },
  };

  assert.equal(typeof result.final_patient_reply, "string");
  assert.ok(result.final_patient_reply.length > 0);
});

test("active tool definitions include kb.search and availability.check only", () => {
  assert.deepEqual(ACTIVE_RUNTIME_AGENT_TOOLS, ["kb.search", "availability.check"]);
  assert.equal("kb.search" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal("availability.check" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal("admin.notify" in RUNTIME_AGENT_TOOL_DEFINITIONS, false);
});

test("future tools are listed but not active", () => {
  assert.deepEqual(FUTURE_RUNTIME_AGENT_TOOLS, [
    "hold.create",
    "booking.confirm",
    "cancel_hold",
    "appointment.lookup",
  ]);

  for (const tool of FUTURE_RUNTIME_AGENT_TOOLS) {
    assert.equal(ACTIVE_RUNTIME_AGENT_TOOLS.includes(tool as (typeof ACTIVE_RUNTIME_AGENT_TOOLS)[number]), false);
    assert.equal(tool in RUNTIME_AGENT_TOOL_DEFINITIONS, false);
  }
});

test("system instruction includes safety and ownership boundaries", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /AI Front Desk agent/i);
  assert.match(instruction, /Use tools for facts and availability/i);
  assert.match(instruction, /Do not invent prices, services, opening hours, availability, bookings/i);
  assert.match(instruction, /Conversation memory is dialogue continuity only/i);
  assert.match(instruction, /Tool results and Supabase\/runtime context are business truth/i);
  assert.match(instruction, /do not ask for a phone number/i);
  assert.match(instruction, /Do not collect phone as a required field/i);
  assert.match(instruction, /ask only for: first name, last name, service\/reason, preferred day\/time/i);
  assert.match(instruction, /Final patient reply must be in the patient'?s language/i);
});

// CBM v1 safety hotfix — system instruction reply behaviour rules

test("CBM/bug5: system instruction has greeting/low-signal guidance — no premature intake", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /Greetings.*low-signal|low-signal.*Greetings/i, "must mention low-signal handling");
  assert.ok(
    instruction.includes("Do NOT immediately ask for service") || instruction.includes("Do not immediately ask for service"),
    "must prohibit immediate service/time intake on greetings",
  );
});

test("CBM/bug1: system instruction has urgent clinical signal guidance", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /urgent clinical signal|pain.*bleeding|bleeding.*pain/i);
  assert.match(instruction, /empathy and urgency/i);
});

test("CBM/bug1-safety: urgent instruction must not unconditionally promise staff follow-up", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.ok(
    !instruction.includes("staff will follow up") && !instruction.includes("с вами свяжутся"),
    "urgent rule must not unconditionally promise 'staff will follow up' — requires handoff side effect proof",
  );
  assert.match(
    instruction,
    /unless a handoff or admin notification side effect was actually created or queued/i,
    "urgent rule must condition any follow-up promise on side effect evidence",
  );
});

test("CBM/bug3: system instruction has human/admin request guidance", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /хочу поговорить с человеком|позовите администратора|Human or admin request/i);
  assert.ok(
    instruction.includes("Do not continue with booking intake") || instruction.includes("do not continue with booking intake"),
    "must prohibit continuing booking intake after human request",
  );
});

test("CBM/bug3-safety: admin instruction must not unconditionally promise staff will assist or contact", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.ok(
    !instruction.includes("staff member will assist") && !instruction.includes("administrator will contact") && !instruction.includes("администратор свяжется"),
    "admin rule must not unconditionally promise staff assistance — requires handoff side effect proof",
  );
  assert.match(
    instruction,
    /unless a notification or handoff side effect was actually created or queued/i,
    "admin rule must condition any notification promise on side effect evidence",
  );
});

test("CBM/bug2: system instruction says to reply in patient language and includes no English-only reply", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /Never reply in English unless the patient wrote in English/i);
});

test("CBM/bug2: system instruction tells agent not to request extra tools when results are available", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(instruction, /tool_results are already provided|results are already available/i);
});

test("system instruction greeting rule is language-neutral — no single-language hardcoded example", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  // Greeting rule must instruct the model to reply in the patient's language,
  // not hardcode only one language as the sole example.
  assert.match(instruction, /in the patient'?s language/i, "greeting rule must reference patient language");
  assert.doesNotMatch(
    instruction,
    /Привет! Чем могу помочь\?/,
    "greeting rule must not hardcode a Russian-only example without language context",
  );
});

test("system instruction contains booking confirmation proof guard", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  assert.match(
    instruction,
    /Do not claim booking is confirmed without explicit backend proof/i,
    "must guard against claiming booking confirmed without backend proof",
  );
});

// Date grounding tests — PR #107

test("date grounding: system instruction includes today's YYYY-MM-DD date when now is provided", () => {
  // 2026-06-27 10:00 UTC = 2026-06-27 12:00 Prague (CEST, UTC+2)
  const now = new Date("2026-06-27T10:00:00Z");
  const instruction = buildRuntimeAgentSystemInstruction({ now });
  assert.match(instruction, /2026-06-27/, "instruction must include the current date in YYYY-MM-DD");
});

test("date grounding: system instruction includes Europe/Prague timezone", () => {
  const now = new Date("2026-06-27T10:00:00Z");
  const instruction = buildRuntimeAgentSystemInstruction({ now });
  assert.match(instruction, /Europe\/Prague/, "instruction must include the configured timezone");
});

test("date grounding: system instruction warns against natural-language dates in availability.check", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(instruction, /Never pass natural-language date strings to availability\.check/i);
  assert.match(instruction, /YYYY-MM-DD/, "must specify the required format");
});

test("date grounding: relative date examples listed (tomorrow, завтра, в пятницу, next week)", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(instruction, /tomorrow/i);
  assert.match(instruction, /завтра/);
  assert.match(instruction, /next week/i);
});

test("date grounding: same-day boundary — 2026-06-27T23:00Z = 2026-06-28 01:00 Prague (next day)", () => {
  const now = new Date("2026-06-27T23:00:00Z"); // UTC+2 → 2026-06-28 01:00 Prague
  const instruction = buildRuntimeAgentSystemInstruction({ now });
  assert.match(instruction, /2026-06-28/, "instruction must reflect Prague date, not UTC date");
  assert.doesNotMatch(instruction, /Today is 2026-06-27/, "UTC date must not appear when Prague date is next day");
});

test("date grounding: agent loop passes deps.now into system_instruction shown to caller", async () => {
  const now = new Date("2026-06-27T10:00:00Z");
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Ok" } };
  };
  await createRuntimeAgentLoop({ model: "m", caller, executors: {}, now }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Есть слоты завтра?",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  });
  assert.ok(capturedInstruction?.includes("2026-06-27"), "system instruction seen by model must include today (2026-06-27)");
  assert.ok(capturedInstruction?.includes("Europe/Prague"), "system instruction must include timezone");
});

test("date grounding: with now=2026-06-27 and mock caller resolving 'завтра' to 2026-06-28, executor receives resolved date", async () => {
  const now = new Date("2026-06-27T10:00:00Z");
  const executedDates: Array<string | undefined> = [];
  const callerInputs: Parameters<RuntimeAgentCaller>[0][] = [];

  const caller: RuntimeAgentCaller = async (input) => {
    callerInputs.push(input);
    if (!input.input.tool_results) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", arguments: { requested_date: "2026-06-28" }, call_id: "call_zavtra" }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Завтра есть слоты." } };
  };

  const executors = {
    "availability.check": async (ctx: import("../src/runtime/toolExecutor.ts").ToolExecutionContext) => {
      executedDates.push(ctx.requested_date);
      return { tool: "availability.check" as const, status: "success" as const, data: { slots: [] } };
    },
  };

  const result = await createRuntimeAgentLoop({ model: "m", caller, executors, now }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Есть слоты завтра?",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  });

  assert.ok(callerInputs[0]?.system_instruction.includes("2026-06-27"), "model must see today (2026-06-27) in system instruction");
  assert.equal(executedDates[0], "2026-06-28", "executor must receive the ISO-resolved date 2026-06-28");
  assert.equal(result.final_patient_reply, "Завтра есть слоты.");
});

test("date grounding: explicit date 2026-07-01 passes through unchanged", async () => {
  const now = new Date("2026-06-27T10:00:00Z");
  const executedDates: Array<string | undefined> = [];

  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", arguments: { requested_date: "2026-07-01" }, call_id: "call_explicit" }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "1 июля есть слоты." } };
  };

  const executors = {
    "availability.check": async (ctx: import("../src/runtime/toolExecutor.ts").ToolExecutionContext) => {
      executedDates.push(ctx.requested_date);
      return { tool: "availability.check" as const, status: "success" as const, data: { slots: [] } };
    },
  };

  await createRuntimeAgentLoop({ model: "m", caller, executors, now }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Есть слоты на 2026-07-01?",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  });

  assert.equal(executedDates[0], "2026-07-01", "explicit ISO date must pass through unchanged");
});

// Date grounding P2 — timezone threading

test("P2: createRuntimeAgentLoop with timezone=America/New_York passes that timezone into system_instruction", async () => {
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Ok" } };
  };
  await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: {},
    now: new Date("2026-06-27T10:00:00Z"),
    timezone: "America/New_York",
  }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Hello",
    locale: "en",
    truth_snapshot: {},
  });
  assert.ok(capturedInstruction?.includes("America/New_York"), "system instruction must include the configured timezone");
  assert.ok(!capturedInstruction?.includes("Europe/Prague"), "must not fall back to Prague when timezone is explicitly set");
});

test("P2: date around midnight differs between America/New_York and Europe/Prague", () => {
  // 2026-06-28T03:00Z = 2026-06-27 23:00 New York (EDT, UTC-4), 2026-06-28 05:00 Prague (CEST, UTC+2)
  const now = new Date("2026-06-28T03:00:00Z");
  const nyInstruction = buildRuntimeAgentSystemInstruction({ now, timezone: "America/New_York" });
  const pragueInstruction = buildRuntimeAgentSystemInstruction({ now, timezone: "Europe/Prague" });
  assert.match(nyInstruction, /2026-06-27/, "New York still on 2026-06-27 at 03:00 UTC");
  assert.match(pragueInstruction, /2026-06-28/, "Prague is already 2026-06-28 at 03:00 UTC");
});

test("P2: default remains Europe/Prague when no timezone provided to createRuntimeAgentLoop", async () => {
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Ok" } };
  };
  await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: {},
    now: new Date("2026-06-27T10:00:00Z"),
  }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Hello",
    locale: "ru",
    truth_snapshot: {},
  });
  assert.ok(capturedInstruction?.includes("Europe/Prague"), "default timezone must be Europe/Prague");
});

test("P2: завтра → ISO date test still passes with non-Prague timezone", async () => {
  const now = new Date("2026-06-27T10:00:00Z"); // 2026-06-27 06:00 New York
  const executedDates: Array<string | undefined> = [];
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", arguments: { requested_date: "2026-06-28" }, call_id: "call_tz" }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Tomorrow has slots." } };
  };
  const executors = {
    "availability.check": async (ctx: import("../src/runtime/toolExecutor.ts").ToolExecutionContext) => {
      executedDates.push(ctx.requested_date);
      return { tool: "availability.check" as const, status: "success" as const, data: { slots: [] } };
    },
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors, now, timezone: "America/New_York" }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: "case_1",
    user_message: "Есть слоты завтра?",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  });
  assert.equal(executedDates[0], "2026-06-28", "executor receives resolved ISO date regardless of timezone");
  assert.equal(result.final_patient_reply, "Tomorrow has slots.");
});

test("module has contract-only implementation with no external runtime integrations", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/openaiRuntimeAgent.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*calendar[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*openai[^"']*["']/i);
  assert.doesNotMatch(source, /new\s+OpenAI\s*\(/i);
  assert.doesNotMatch(source, /openai\.[a-z]/i);
});
