import type { SpeechEngineCallbacks, SpeechEngineSession, TranscriptMessage } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
import type { RuntimeVoiceClientDeps } from "./runtimeVoiceClient.ts";
import { createRuntimeVoiceClient } from "./runtimeVoiceClient.ts";
import { safeVoiceLog } from "./safeVoiceLogger.ts";
import type { VoiceCallContextRegistry } from "./voiceCallContext.ts";
import type { VoiceTransferController } from "./voiceTransfer.ts";

export interface ElevenLabsBrainDeps extends RuntimeVoiceClientDeps {
  voiceClinicCode: string;
  voiceFallbackReply: string;
  callRegistry?: VoiceCallContextRegistry;
  transferController?: VoiceTransferController;
}

export function createElevenLabsBrainCallbacks(deps: ElevenLabsBrainDeps): SpeechEngineCallbacks {
  const runtimeClient = createRuntimeVoiceClient(deps);
  const turnCounters = new Map<SpeechEngineSession, number>();

  return {
    onInit(conversationId: string, _session: SpeechEngineSession) {
      safeVoiceLog({ event: "brain_init", conversation_id: conversationId, stage: "ready" });
    },

    onTranscript(transcript: TranscriptMessage[], signal: AbortSignal, session: SpeechEngineSession) {
      const latest = [...transcript].reverse().find((m) => m.role === "user");
      if (!latest) return;

      const text = latest.content.trim();
      if (!text) return;

      const turnNumber = (turnCounters.get(session) ?? 0) + 1;
      turnCounters.set(session, turnNumber);

      const conversationId = session.conversationId;
      if (!conversationId) {
        safeVoiceLog({
          event: "brain_missing_conversation_id",
          turn_number: turnNumber,
          stage: "skipped",
        });
        if (!signal.aborted) void session.sendResponse(deps.voiceFallbackReply);
        return;
      }

      const callContext = deps.callRegistry?.getByConversationId(conversationId) ?? null;
      safeVoiceLog({
        event: "brain_transcript_received",
        conversation_id: conversationId,
        call_sid: callContext?.callSid,
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
          callContext,
        })
        .then(async (result) => {
          if (signal.aborted) {
            safeVoiceLog({
              event: "brain_stale_response_suppressed",
              conversation_id: conversationId,
              turn_number: turnNumber,
            });
            return;
          }

          if (result.liveTransfer) {
            if (!callContext?.callSid || !deps.transferController) {
              safeVoiceLog({
                event: "voice_transfer_unavailable",
                conversation_id: conversationId,
                call_sid: callContext?.callSid,
                request_id: result.liveTransfer.requestId,
                stage: "missing_call_control",
              });
            } else {
              const transfer = await deps.transferController.transfer(
                callContext.callSid,
                result.liveTransfer.requestId,
              );
              if (transfer.ok) {
                safeVoiceLog({
                  event: "brain_live_transfer_started",
                  conversation_id: conversationId,
                  call_sid: callContext.callSid,
                  request_id: result.liveTransfer.requestId,
                  latency_ms: Date.now() - started,
                });
                // Twilio now owns the call transition. Do not play the pre-transfer Runtime
                // receipt over the stream after the live call has been redirected.
                return;
              }
            }
          }

          safeVoiceLog({
            event: "brain_runtime_reply",
            conversation_id: conversationId,
            call_sid: callContext?.callSid,
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
            call_sid: callContext?.callSid,
            turn_number: turnNumber,
            error_code: err instanceof Error ? err.name : "unknown",
          });
          if (!signal.aborted) void session.sendResponse(deps.voiceFallbackReply);
        });
    },

    onClose(session: SpeechEngineSession) {
      turnCounters.delete(session);
      if (session.conversationId) deps.callRegistry?.finishByConversationId(session.conversationId);
      safeVoiceLog({ event: "brain_close", conversation_id: session.conversationId });
    },

    onDisconnect(session: SpeechEngineSession) {
      turnCounters.delete(session);
      if (session.conversationId) deps.callRegistry?.finishByConversationId(session.conversationId);
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
