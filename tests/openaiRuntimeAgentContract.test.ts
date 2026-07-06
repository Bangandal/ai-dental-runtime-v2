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

test("active tool definitions include kb.search, availability.check, and booking.apply", () => {
  assert.deepEqual(ACTIVE_RUNTIME_AGENT_TOOLS, ["kb.search", "availability.check", "booking.apply"]);
  assert.equal("kb.search" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal("availability.check" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal("booking.apply" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal("admin.notify" in RUNTIME_AGENT_TOOL_DEFINITIONS, false);
});

test("booking.apply is active now that phone pass-through is wired end-to-end (PR #116)", () => {
  assert.equal("booking.apply" in RUNTIME_AGENT_TOOL_DEFINITIONS, true);
  assert.equal((ACTIVE_RUNTIME_AGENT_TOOLS as readonly string[]).includes("booking.apply"), true);
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

// First-turn greeting / tone update

test("first-turn greeting: is_new_conversation=true includes clinic assistant self-introduction", () => {
  const instruction = buildRuntimeAgentSystemInstruction({ is_new_conversation: true });
  assert.match(instruction, /помощник администратора клиники/i, "must include clinic assistant identity on first turn");
  assert.match(instruction, /in the patient'?s language|patient'?s language/i, "greeting must reference patient language");
});

test("first-turn greeting: is_new_conversation=true must not claim to be a human administrator", () => {
  const instruction = buildRuntimeAgentSystemInstruction({ is_new_conversation: true });
  assert.match(instruction, /Do NOT claim to be a human administrator/i, "must explicitly forbid claiming to be human");
});

test("first-turn greeting: is_new_conversation=true instructs no re-introduction on subsequent turns", () => {
  const instruction = buildRuntimeAgentSystemInstruction({ is_new_conversation: true });
  assert.match(instruction, /Do NOT repeat this introduction on subsequent turns/i, "must suppress re-introduction after first turn");
});

test("first-turn greeting: is_new_conversation=false omits clinic assistant self-introduction", () => {
  const instruction = buildRuntimeAgentSystemInstruction({ is_new_conversation: false });
  assert.doesNotMatch(instruction, /помощник администратора клиники/i, "must NOT include self-introduction on subsequent turns");
});

test("first-turn greeting: default (no option) omits clinic assistant self-introduction", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.doesNotMatch(instruction, /помощник администратора клиники/i, "default must NOT include self-introduction");
});

test("first-turn greeting: agent loop uses is_first_patient_turn=true (not conversation_id) as signal", async () => {
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Здравствуйте!" } };
  };
  // is_first_patient_turn=true with a pre-created conversation_id (simulates orchestrator
  // calling createOpenAIConversation before runTurn on a genuine first patient turn)
  await createRuntimeAgentLoop({ model: "m", caller, executors: {} }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: null,
    conversation_id: "conv_newly_created_before_runturn",
    is_first_patient_turn: true,
    user_message: "Привет",
    locale: "ru",
  });
  assert.ok(capturedInstruction?.includes("помощник администратора клиники"), "explicit is_first_patient_turn=true must show greeting even if conversation_id is already set");
});

test("first-turn greeting: agent loop uses is_first_patient_turn=false to suppress self-introduction", async () => {
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Чем могу помочь?" } };
  };
  await createRuntimeAgentLoop({ model: "m", caller, executors: {} }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: null,
    conversation_id: "conv_existing_123",
    is_first_patient_turn: false,
    user_message: "Привет ещё раз",
    locale: "ru",
  });
  assert.ok(!capturedInstruction?.includes("помощник администратора клиники"), "is_first_patient_turn=false must NOT include self-introduction");
});

test("booking.apply arg names: prompt uses first_name and last_name, not patient_first_name or patient_last_name", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(instruction, /\bfirst_name\b/, "prompt must contain first_name");
  assert.match(instruction, /\blast_name\b/, "prompt must contain last_name");
  assert.doesNotMatch(instruction, /patient_first_name/, "prompt must NOT contain patient_first_name");
  assert.doesNotMatch(instruction, /patient_last_name/, "prompt must NOT contain patient_last_name");
});

test("first-turn greeting: is_first_patient_turn unset defaults to no self-introduction", async () => {
  let capturedInstruction: string | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    capturedInstruction = input.system_instruction;
    return { type: "final_response", final_response: { final_patient_reply: "Окей" } };
  };
  // No is_first_patient_turn field — agent loop should default to false (safe)
  await createRuntimeAgentLoop({ model: "m", caller, executors: {} }).runTurn({
    clinic_id: "clinic_1",
    contact_id: "c1",
    case_id: null,
    conversation_id: null,
    user_message: "Привет",
    locale: "ru",
  });
  assert.ok(!capturedInstruction?.includes("помощник администратора клиники"), "missing is_first_patient_turn must default to no self-introduction");
});

// ── Multi-turn name regression fix (PR #148) ─────────────────────────────────

test("intake: prompt uses flexible collection, not rigid Service→Name→Time order", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(instruction, /collect missing details flexibly/i, "must say 'collect missing details flexibly'");
  assert.match(instruction, /fallback, not a strict order/i, "must say the sequence is a fallback, not a strict order");
});

test("intake: prompt does not enforce 'collect in order' mandatory sequence", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.doesNotMatch(instruction, /collect in order/i, "must NOT say 'collect in order'");
  assert.doesNotMatch(instruction, /collect in strict order/i, "must NOT say 'collect in strict order'");
});

test("intake: prompt instructs model to check current message and conversation history before asking", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(
    instruction,
    /Check the current message and available conversation history first/i,
    "must instruct model to check current message and conversation history before asking",
  );
});

test("intake: prompt says do not re-ask for a field only because BPS has not persisted it", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(
    instruction,
    /do not re-ask for a field only because booking_process_state has not persisted it/i,
    "must say: do not re-ask for a field only because booking_process_state has not persisted it",
  );
});

test("intake: prompt uses first_name/last_name (not patient_first_name/patient_last_name)", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(instruction, /\bfirst_name\b/, "prompt must contain first_name");
  assert.match(instruction, /\blast_name\b/, "prompt must contain last_name");
  assert.doesNotMatch(instruction, /patient_first_name/, "prompt must NOT contain patient_first_name");
  assert.doesNotMatch(instruction, /patient_last_name/, "prompt must NOT contain patient_last_name");
});

test("intake: prompt excludes CASE CONTEXT AUTHORITY", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.doesNotMatch(instruction, /CASE CONTEXT AUTHORITY/i, "prompt must NOT contain CASE CONTEXT AUTHORITY");
});

test("intake: slot_conflict rule instructs model to retain name/service, ask only for new time", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.match(
    instruction,
    /After slot_conflict.*do NOT restart intake/i,
    "must say: After slot_conflict do NOT restart intake",
  );
  assert.match(
    instruction,
    /Retain name and service from the current conversation/i,
    "must say: Retain name and service from the current conversation",
  );
  assert.match(
    instruction,
    /Ask only for a new time/i,
    "must say: Ask only for a new time (after slot_conflict)",
  );
});

test("intake: snapshot — INTAKE FLOW section has the exact flexible wording for Turn-2 name retention", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  // Verify the full flexible intake rule as written in the prompt
  assert.ok(
    instruction.includes(
      "collect missing details flexibly. Check the current message and available conversation history first; ask only for what is genuinely missing. The sequence (service → name → time) is a fallback, not a strict order. Do not re-ask for a field only because booking_process_state has not persisted it — if the patient stated it earlier in this conversation, it is already known.",
    ),
    "INTAKE FLOW flexible rule must be present verbatim (snapshot guard against regression)",
  );

  // Verify the name retention sub-rule for Turn-2
  assert.ok(
    instruction.includes(
      "use first_name and last_name from the current message or any prior turn in this conversation. Do NOT re-ask if the patient stated their name at any point in this conversation.",
    ),
    "Name sub-rule must tell model to use name from any prior turn (Turn-2 guard)",
  );
});
