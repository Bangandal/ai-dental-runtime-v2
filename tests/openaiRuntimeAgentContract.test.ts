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
