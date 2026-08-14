import { readVoiceConfig } from "./voiceConfig.ts";
import { createVoiceGatewayServer } from "./voiceGatewayServer.ts";

const config = readVoiceConfig();
const gateway = createVoiceGatewayServer(config);

process.on("SIGTERM", () => gateway.stop().then(() => process.exit(0)));
process.on("SIGINT", () => gateway.stop().then(() => process.exit(0)));

gateway.start().catch((err: unknown) => {
  console.error("Voice gateway failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
