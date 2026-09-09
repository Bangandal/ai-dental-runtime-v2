import type { FastifyInstance, FastifyRequest } from "fastify";
import { checkRuntimeApiKey } from "./runtimeApiAuth.ts";
import type { VoiceToolAuthorityRequest, VoiceToolAuthorityResponse } from "./voiceToolAuthority.ts";

export interface VoiceToolAuthorityRouteDeps {
  execute: (request: VoiceToolAuthorityRequest) => Promise<VoiceToolAuthorityResponse>;
  apiKey?: string;
  isProduction?: boolean;
}

/** Private server-to-server tool surface for the Realtime sideband controller. */
export function registerVoiceToolAuthorityRoute(
  app: FastifyInstance,
  deps: VoiceToolAuthorityRouteDeps,
): void {
  app.post("/runtime/voice/tool", async (request, reply) => {
    const auth = checkRuntimeApiKey({
      configuredKey: deps.apiKey,
      authHeader: header(request, "authorization"),
      apiKeyHeader: header(request, "x-runtime-api-key"),
      isProduction: deps.isProduction ?? false,
    });
    if (!auth.ok) {
      reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } });
      return;
    }

    const body = request.body as VoiceToolAuthorityRequest;
    const result = await deps.execute(body).catch(() => ({
      ok: false as const,
      error: { code: "voice_tool_authority_failed", message: "Voice tool authority failed" },
    }));

    if (!result.ok) {
      reply.code(result.error.code === "invalid_voice_tool_request" ? 400 : 422).send(result);
      return;
    }
    reply.send(result);
  });
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
