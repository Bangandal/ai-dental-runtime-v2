// R2a compatibility facade.
//
// The historical Runtime loop is intentionally frozen behind a legacy boundary so
// new Runtime/BookingKernel code does not keep growing inside the monolith. Existing
// imports remain stable while responsibilities are extracted behind smaller modules.

import { createRuntimeAgentLoop as createLegacyRuntimeAgentLoop } from "./runtimeAgentLoopLegacy.ts";
import type {
  CreateRuntimeAgentLoopDeps,
  RuntimeAgentCallerInput,
  RuntimeAgentCallerOutput,
} from "./runtimeAgentLoopLegacy.ts";
import type {
  OpenAIRuntimeAgent,
  RuntimeAgentToolRequest,
} from "./openaiRuntimeAgent.ts";

export * from "./runtimeAgentLoopLegacy.ts";

/**
 * PF-004a compatibility adapter.
 *
 * When the model already emits exactly one booking.select_slot and one booking.apply
 * in the same tool batch, do not force the model to decide "book" a second time.
 * The legacy loop receives the selection first; on its next internal caller step we
 * deterministically replay the already-issued booking.apply request. All existing
 * booking guards, identity checks, slot policy, locking and ClinicCard writes remain
 * owned by the legacy Runtime path.
 *
 * The adapter is created per runTurn so staged requests cannot leak across concurrent
 * patient turns.
 */
export function createRuntimeAgentLoop(deps: CreateRuntimeAgentLoopDeps): OpenAIRuntimeAgent {
  return {
    async runTurn(input) {
      let stagedBookingApply: RuntimeAgentToolRequest | null = null;

      const caller = async (callerInput: RuntimeAgentCallerInput): Promise<RuntimeAgentCallerOutput> => {
        if (
          stagedBookingApply
          && Array.isArray(callerInput.input.tool_results)
          && callerInput.input.tool_results.some((result) => result.tool === "booking.select_slot")
        ) {
          const request = stagedBookingApply;
          stagedBookingApply = null;
          return {
            type: "tool_requests",
            conversation_id: callerInput.conversation_id,
            tool_requests: [request],
          };
        }

        const output = await deps.caller(callerInput);
        if (output.type !== "tool_requests") return output;

        const selectSlots = output.tool_requests.filter((request) => request.tool === "booking.select_slot");
        const bookingApplies = output.tool_requests.filter((request) => request.tool === "booking.apply");

        // Only rewrite the unambiguous case. Multiple selections/applies continue through
        // the legacy fail-closed guards unchanged.
        if (selectSlots.length === 1 && bookingApplies.length === 1) {
          stagedBookingApply = bookingApplies[0];
          return {
            ...output,
            tool_requests: output.tool_requests.filter(
              (request) => request.call_id !== stagedBookingApply!.call_id,
            ),
          };
        }

        return output;
      };

      const legacy = createLegacyRuntimeAgentLoop({ ...deps, caller });
      return legacy.runTurn(input);
    },
  };
}
