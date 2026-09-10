import test from "node:test";
import assert from "node:assert/strict";
import { buildHumanTransferTwiml, createVoiceTransferController } from "../src/voice/voiceTransfer.ts";

test("voice transfer builds TwiML that dials the configured human destination", () => {
  const xml = buildHumanTransferTwiml("+420700000010");
  assert.match(xml, /<Dial[^>]*answerOnBridge="true"/);
  assert.match(xml, /<Number>\+420700000010<\/Number>/);
});

test("voice transfer updates only the proven active CallSid", async () => {
  const updates: Array<{ callSid: string; twiml: string }> = [];
  const controller = createVoiceTransferController({
    humanTransferNumber: "+420700000010",
    client: {
      calls(callSid) {
        return {
          async update(input) {
            updates.push({ callSid, twiml: input.twiml });
            return {};
          },
        };
      },
    },
  });

  const result = await controller.transfer("CA-live-1", "request-1");
  assert.deepEqual(result, { ok: true });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.callSid, "CA-live-1");
});

test("voice transfer fails closed when provider call control is not configured", async () => {
  const controller = createVoiceTransferController({});
  assert.deepEqual(await controller.transfer("CA-live-2", "request-2"), {
    ok: false,
    reason: "not_configured",
  });
});
