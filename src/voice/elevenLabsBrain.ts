import type { SpeechEngineCallbacks, SpeechEngineSession, TranscriptMessage } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
import type { RuntimeVoiceClientDeps } from "./runtimeVoiceClient.ts";
import { createRuntimeVoiceClient } from "./runtimeVoiceClient.ts";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface ElevenLabsBrainDeps extends RuntimeVoiceClientDeps {
  voiceClinicCode: string;
  voiceFirstMessage: string;
}

export function createElevenLabsBrainCallbacks(deps: ElevenLabsBrainDeps): SpeechEngineCallbacks {
  const runtimeClient = createRuntimeVoiceClient(deps);
  const turnCounters = new Map<SpeechEngineSession, number>();

  return {
    onInit(conversationId: string, session: SpeechEngineSession) {
      safeVoiceLog({ event: "brain_init", conversation_id: conversationId, stage: "greeting" });
      session.sendResponse(deps.voiceFirstMessage);
    },

    onTranscript(transcript: TranscriptMessage[], signal: AbortSignal, session: SpeechEngineSession) {
      const latest = [...transcript].reverse().find((m) => m.role === "user");
      if (!latest) return;

      const text = latest.content.trim();
      if (!text) return;

      const turnNumber = (turnCounters.get(session) ?? 0) + 1;
      turnCounters.set(session, turnNumber);

      const conversationId = session.conversationId ?? "unknown";

      safeVoiceLog({
        event: "brain_transcript_received",
        conversation_id: conversationId,
        turn_number: turnNumber,
        stage: "runtime_call_start",
      });

      const started = Date.now();

      runtimeClient
        .callRuntimeTurn({
          clinicCode: deps.voiceClinicCode,
          conversationId,
          patientTranscript: text,
          turnNumber,
          signal,
        })
        .then((result) => {
          if (signal.aborted) {
            safeVoiceLog({
              event: "brain_stale_response_suppressed",
              conversation_id: conversationId,
              turn_number: turnNumber,
            });
            return;
          }
          safeVoiceLog({
            event: "brain_runtime_reply",
            conversation_id: conversationId,
            turn_number: turnNumber,
            stage: "send_response",
            latency_ms: Date.now() - started,
          });
          session.sendResponse(result.reply);
        })
        .catch((err: unknown) => {
          safeVoiceLog({
            event: "brain_runtime_error",
            conversation_id: conversationId,
            turn_number: turnNumber,
            error_code: err instanceof Error ? err.name : "unknown",
          });
        });
    },

    onClose(session: SpeechEngineSession) {
      turnCounters.delete(session);
      safeVoiceLog({ event: "brain_close", conversation_id: session.conversationId });
    },

    onDisconnect(session: SpeechEngineSession) {
      turnCounters.delete(session);
      safeVoiceLog({
        event: "brain_disconnect",
        conversation_id: session.conversationId,
        connection_state: "disconnected",
      });
    },

    onError(error: Error, session: SpeechEngineSession) {
      safeVoiceLog({
        event: "brain_error",
        conversation_id: session.conversationId,
        error_code: error.name,
      });
    },
  };
}
