import type { SpeechEngineCallbacks, SpeechEngineSession, TranscriptMessage } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
import type { RuntimeVoiceClientDeps } from "./runtimeVoiceClient.ts";
import { createRuntimeVoiceClient } from "./runtimeVoiceClient.ts";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface ElevenLabsBrainDeps extends RuntimeVoiceClientDeps {
  voiceClinicCode: string;
  voiceFallbackReply: string;
}

interface ActiveSemanticTurn {
  /** Number of user messages in ElevenLabs' full transcript history. */
  userTurnOrdinal: number;
  turnNumber: number;
  controller: AbortController;
  reply?: string;
}

export function createElevenLabsBrainCallbacks(deps: ElevenLabsBrainDeps): SpeechEngineCallbacks {
  const runtimeClient = createRuntimeVoiceClient(deps);
  const turnCounters = new Map<SpeechEngineSession, number>();
  const activeTurns = new Map<SpeechEngineSession, ActiveSemanticTurn>();

  function clearSessionState(session: SpeechEngineSession): void {
    activeTurns.get(session)?.controller.abort();
    activeTurns.delete(session);
    turnCounters.delete(session);
  }

  return {
    onInit(conversationId: string, _session: SpeechEngineSession) {
      // Greeting is sent via conversation_initiation_client_data first_message override (not here)
      safeVoiceLog({ event: "brain_init", conversation_id: conversationId, stage: "ready" });
    },

    onTranscript(transcript: TranscriptMessage[], _sdkSignal: AbortSignal, session: SpeechEngineSession) {
      const userMessages = transcript.filter((m) => m.role === "user");
      const latest = userMessages.at(-1);
      if (!latest) return;

      const text = latest.content.trim();
      if (!text) return;

      // ElevenLabs sends the full conversation history on each user_transcript.
      // In live WebRTC we can receive multiple protocol events for the same
      // semantic user turn. The SDK aborts the previous event signal before it
      // calls us, so tying Runtime directly to that signal causes duplicate
      // events to cancel and restart the same business turn repeatedly.
      //
      // The number of user messages is stable for duplicate events, but grows
      // when the caller actually speaks a new turn. Keep our own AbortController
      // at that semantic-turn level.
      const userTurnOrdinal = userMessages.length;
      const current = activeTurns.get(session);

      if (current?.userTurnOrdinal === userTurnOrdinal) {
        safeVoiceLog({
          event: "brain_duplicate_transcript_coalesced",
          conversation_id: session.conversationId,
          turn_number: current.turnNumber,
          stage: current.reply ? "rebind_cached_reply" : "runtime_in_flight",
        });

        // A new Speech Engine event_id invalidates an older agent_response.
        // If Runtime already completed, resend the cached reply so the SDK
        // attaches it to the newest event_id without another Runtime call.
        if (current.reply) {
          void session.sendResponse(current.reply);
        }
        return;
      }

      // A genuinely new caller turn supersedes the previous business turn.
      current?.controller.abort();

      const turnNumber = (turnCounters.get(session) ?? 0) + 1;
      turnCounters.set(session, turnNumber);

      // Section 10: guard conversationId, never call runtime with "unknown" identity
      const conversationId = session.conversationId;
      if (!conversationId) {
        safeVoiceLog({
          event: "brain_missing_conversation_id",
          turn_number: turnNumber,
          stage: "skipped",
        });
        void session.sendResponse(deps.voiceFallbackReply);
        return;
      }

      const controller = new AbortController();
      const semanticTurn: ActiveSemanticTurn = {
        userTurnOrdinal,
        turnNumber,
        controller,
      };
      activeTurns.set(session, semanticTurn);

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
          signal: controller.signal,
        })
        .then((result) => {
          const active = activeTurns.get(session);
          if (controller.signal.aborted || active !== semanticTurn) {
            safeVoiceLog({
              event: "brain_stale_response_suppressed",
              conversation_id: conversationId,
              turn_number: turnNumber,
            });
            return;
          }

          semanticTurn.reply = result.reply;
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
          const active = activeTurns.get(session);
          const isAborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");

          safeVoiceLog({
            event: "brain_runtime_error",
            conversation_id: conversationId,
            turn_number: turnNumber,
            error_code: err instanceof Error ? err.name : "unknown",
          });

          // A newer semantic caller turn intentionally aborts this request.
          if (isAborted || active !== semanticTurn) return;

          // Section 9: real Runtime failure gets one fallback, cached so a
          // duplicate Speech Engine event can rebind it without a new call.
          semanticTurn.reply = deps.voiceFallbackReply;
          void session.sendResponse(deps.voiceFallbackReply);
        });
    },

    onClose(session: SpeechEngineSession) {
      clearSessionState(session);
      safeVoiceLog({ event: "brain_close", conversation_id: session.conversationId });
    },

    onDisconnect(session: SpeechEngineSession) {
      clearSessionState(session);
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
