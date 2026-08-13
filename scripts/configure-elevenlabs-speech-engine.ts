import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const apiKey = process.env.ELEVENLABS_API_KEY;
const speechEngineId = process.env.ELEVENLABS_SPEECH_ENGINE_ID;
const voicePublicBaseUrl = process.env.VOICE_PUBLIC_BASE_URL?.replace(/\/$/, "");
const ttsModelId = process.env.VOICE_TTS_MODEL_ID?.trim() || "eleven_flash_v2_5";

if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY");
if (!speechEngineId) throw new Error("Missing ELEVENLABS_SPEECH_ENGINE_ID");
if (!voicePublicBaseUrl) throw new Error("Missing VOICE_PUBLIC_BASE_URL");

const brainWsUrl = `${voicePublicBaseUrl.replace(/^http/, "ws")}/voice/brain`;

console.log(`Configuring Speech Engine ${speechEngineId}`);
console.log(`  brain WS URL: ${brainWsUrl}`);
console.log(`  ASR: ulaw_8000 / scribe_realtime`);
console.log(`  TTS: ulaw_8000 / ${ttsModelId}`);

const client = new ElevenLabsClient({ apiKey });

const result = await client.speechEngine.update(speechEngineId, {
  speechEngine: { wsUrl: brainWsUrl },
  asr: { userInputAudioFormat: "ulaw_8000", provider: "scribe_realtime" },
  tts: { modelId: ttsModelId as "eleven_flash_v2_5", agentOutputAudioFormat: "ulaw_8000" },
});

console.log(`Done. Speech Engine updated: ${result.engineId}`);
