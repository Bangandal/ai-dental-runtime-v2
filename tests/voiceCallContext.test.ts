import test from "node:test";
import assert from "node:assert/strict";
import { VoiceCallContextRegistry } from "../src/voice/voiceCallContext.ts";

test("voice call registry correlates Twilio call and ElevenLabs conversation without durable PII", () => {
  const registry = new VoiceCallContextRegistry(1_000);
  registry.register({
    callSid: "CA123",
    streamSid: "MZ123",
    callerPhone: "+420700000001",
    calledNumber: "+420700000002",
  }, 100);
  registry.bindConversation("CA123", "conv_123");

  assert.deepEqual(registry.getByConversationId("conv_123", 200), {
    callSid: "CA123",
    streamSid: "MZ123",
    callerPhone: "+420700000001",
    calledNumber: "+420700000002",
    conversationId: "conv_123",
    startedAt: 100,
  });

  registry.finishByConversationId("conv_123");
  assert.equal(registry.getByConversationId("conv_123", 300), null);
  assert.equal(registry.getByCallSid("CA123", 300), null);
});

test("voice call registry expires stale call metadata", () => {
  const registry = new VoiceCallContextRegistry(50);
  registry.register({ callSid: "CA-old", streamSid: "MZ-old", callerPhone: "+420700000003" }, 100);
  assert.equal(registry.getByCallSid("CA-old", 151), null);
});
