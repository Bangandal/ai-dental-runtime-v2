import {
  createRuntimeTurnSerialQueue,
  runRuntimeTurnSerialized,
} from "./runtimeTurnSerialQueue.ts";
import { withDurableConversationContinuity } from "./runtimeConversationContinuity.ts";
import {
  runRuntimeTurnOrchestrated as runRuntimeTurnOrchestratedLegacy,
} from "./runtimeTurnOrchestratorLegacy.ts";

export {
  applyMessengerPhonePolicy,
  getCaseLiteMode,
  type CaseLiteMode,
  type RuntimeTurnOrchestratorDeps,
  type RuntimeTurnOrchestratorResult,
} from "./runtimeTurnOrchestratorLegacy.ts";

const runtimeTurnSerialQueue = createRuntimeTurnSerialQueue();

export function runRuntimeTurnOrchestrated(
  body: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[0],
  deps: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[1],
  opts?: Parameters<typeof runRuntimeTurnOrchestratedLegacy>[2],
): ReturnType<typeof runRuntimeTurnOrchestratedLegacy> {
  return runRuntimeTurnSerialized({
    body,
    queue: runtimeTurnSerialQueue,
    task: () => runRuntimeTurnOrchestratedLegacy(
      body,
      withDurableConversationContinuity(deps),
      opts,
    ),
  });
}
