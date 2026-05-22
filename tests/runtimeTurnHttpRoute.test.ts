import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRuntimeTurnRoute } from "../src/runtime/runtimeTurnHttpRoute.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

function createRouteHarness(service: RuntimeTurnService) {
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;
  registerRuntimeTurnRoute(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    { runtimeTurnService: service },
  );

  assert.ok(handler);

  async function invoke(body: Record<string, unknown>) {
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(nextCode: number) {
        statusCode = nextCode;
        return reply;
      },
      send(nextPayload: unknown) {
        payload = nextPayload;
      },
    };

    await handler!({ body }, reply);
    return { statusCode, payload };
  }

  return { invoke };
}

test("valid payload maps RuntimeTurnInput and returns n8n-compatible reply", async () => {
  const calls: unknown[] = [];
  const harness = createRouteHarness({
    async runTurn(input) {
      calls.push(input);
      return {
        final_patient_reply: "Здравствуйте!",
        conversation_id: "conv_22",
        tool_requests: [],
        tool_results: [{ tool: "kb.search", status: "success" }],
      } as any;
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    chat_id: "chat_1",
    text: "Привет",
    meta: { language_code: "ru" },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.reply_text, "Здравствуйте!");
  assert.equal(payload.final_patient_reply, "Здравствуйте!");
  assert.equal(payload.side_effects.length, 0);
  assert.equal(typeof payload.trace_id, "string");

  const input = calls[0] as Record<string, any>;
  assert.equal(input.clinic_id, CLINIC_UUID);
  assert.equal(input.contact_id, "telegram:user_1");
  assert.equal(input.case_id, null);
  assert.equal(input.user_message, "Привет");
  assert.equal(input.locale, "ru");
});

test("invalid request returns 400", async () => {
  const harness = createRouteHarness({ runTurn: async () => {
    throw new Error("should not run");
  } });

  const missingText = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
  });
  assert.equal(missingText.statusCode, 400);

  const missingClinic = await harness.invoke({
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });
  assert.equal(missingClinic.statusCode, 400);

  const invalidClinicCode = await harness.invoke({
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });
  assert.equal(invalidClinicCode.statusCode, 400);
});

test("service failure returns safe fallback and admin_notification side effect", async () => {
  const harness = createRouteHarness({
    runTurn: async () => {
      throw new Error("runtime exploded");
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    chat_id: "chat_1",
    text: "Помогите",
  });

  assert.equal(response.statusCode, 200);
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.reply_text.includes("Извините"), true);
  assert.equal(payload.side_effects[0].type, "admin_notification");
  assert.equal(payload.debug.runtime_error, "runtime exploded");
});

test("request does not require conversation_id from n8n", async () => {
  const calls: unknown[] = [];
  const harness = createRouteHarness({
    async runTurn(input) {
      calls.push(input);
      return {
        final_patient_reply: "ok",
        conversation_id: "conv_55",
        tool_requests: [],
        tool_results: [],
      } as any;
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    chat_id: "chat_1",
    text: "Hello",
  });

  assert.equal((calls[0] as Record<string, unknown>).conversation_id, undefined);
  assert.equal((response.payload as Record<string, unknown>).conversation_id, "conv_55");
});

test("route module keeps transport/business boundaries", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeTurnHttpRoute.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /booking\./i);
  assert.match(source, /runtimeTurnService\.runTurn/);
});
