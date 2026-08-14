import type { SpeechEngineCallbacks, SpeechEngineSession, TranscriptMessage } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
import type { RuntimeVoiceClientDeps } from "./runtimeVoiceClient.ts";
import { createRuntimeVoiceClient } from "./runtimeVoiceClient.ts";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface ElevenLabsBrainDeps extends RuntimeVoiceClientDeps {
  voiceClinicCode: string;
  voiceFallbackReply: string;
}

export function createElevenLabsBrainCallbacks(deps: ElevenLabsBrainDeps): SpeechEngineCallbacks {
  const runtimeClient = createRuntimeVoiceClient(deps);
  const turnCounters = new Map<SpeechEngineSession, number>();

  return {
    onInit(conversationId: string, _session: SpeechEngineSession) {
      // Greeting is sent via conversation_initiation_client_data first_message override (not here)
      safeVoiceLog({ event: "brain_init", conversation_id: conversationId, stage: "ready" });
    },

    onTranscript(transcript: TranscriptMessage[], signal: AbortSignal, session: SpeechEngineSession) {
      const latest = [...transcript].reverse().find((m) => m.role === "user");
      if (!latest) return;

      const text = latest.content.trim();
      if (!text) return;

      const turnNumber = (turnCounters.get(session) ?? 0) + 1;
      turnCounters.set(session, turnNumber);

      // Section 10: guard conversationId — never call runtime with "unknown" identity
      const conversationId = session.conversationId;
      if (!conversationId) {
        safeVoiceLog({
          event: "brain_missing_conversation_id",
          turn_number: turnNumber,
          stage: "skipped",
        });
        if (!signal.aborted) {
          void session.sendResponse(deps.voiceFallbackReply);
        }
        return;
      }

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
          void session.sendResponse(result.reply);
        })
        .catch((err: unknown) => {
          safeVoiceLog({
            event: "brain_runtime_error",
            conversation_id: conversationId,
            turn_number: turnNumber,
            error_code: err instanceof Error ? err.name : "unknown",
          });
          // Section 9: send fallback only if not aborted
          if (!signal.aborted) {
            void session.sendResponse(deps.voiceFallbackReply);
          }
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
