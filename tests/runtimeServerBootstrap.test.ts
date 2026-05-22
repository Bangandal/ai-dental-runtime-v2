import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRuntimeRoutes } from "../src/runtime/runtimeServerBootstrap.ts";
const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

test("registerRuntimeRoutes wires /runtime/turn to RuntimeTurnService built via createDentalRuntimeTurnService", async () => {
  const responseCalls: unknown[] = [];
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;

  registerRuntimeRoutes(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    {
      model: "gpt-test",
      openaiClient: {
        responses: {
          async create(payload) {
            responseCalls.push(payload);
            return { output_text: "Здравствуйте!" };
          },
        },
      },
      rpc: async () => ({ data: [], error: null }),
    },
  );

  assert.ok(handler);

  let payload: unknown;
  const reply = {
    code() {
      return reply;
    },
    send(nextPayload: unknown) {
      payload = nextPayload;
    },
  };

  await handler!(
    {
      body: {
        clinic_code: CLINIC_UUID,
        channel: "telegram",
        external_user_id: "user_1",
        text: "Привет",
      },
    },
    reply,
  );

  const transportPayload = payload as Record<string, any>;
  assert.equal(transportPayload.reply_text, "Здравствуйте!");
  assert.deepEqual(transportPayload.side_effects, []);
  assert.equal(responseCalls.length >= 1, true);
});

test("runtime bootstrap module does not keep legacy runtime wiring references", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeServerBootstrap.ts");
  const source = await readFile(modulePath, "utf8");

  assert.match(source, /registerRuntimeTurnRoute/);
  assert.match(source, /createDentalRuntimeTurnService/);
  assert.doesNotMatch(source, /registerOldRuntimeTurnRoute|legacyRuntime|runtimeTurnPipeline/i);
});
