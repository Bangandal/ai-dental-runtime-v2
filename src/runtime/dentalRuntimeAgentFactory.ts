import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import { createRuntimeAgentLoop } from "./runtimeAgentLoop.ts";
import { createOpenAIRuntimeAgentCaller, type OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import { createSupabaseKnowledgeRepository, type EmbeddingClient, type RpcCaller } from "./supabaseKnowledgeRepository.ts";
import { createKbSearchExecutor } from "./kbSearchExecutor.ts";
import { createClinicCardAvailabilityExecutor } from "../integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { ToolExecutor } from "./toolExecutor.ts";
import type { OpenAIRuntimeAgent } from "./openaiRuntimeAgent.ts";

export interface CreateDentalRuntimeAgentDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  conversationMemoryRepository?: ConversationMemoryRepository;
  now?: Date;
  clinicCardAvailabilityExecutor?: ToolExecutor;
}

export function createDentalRuntimeAgent(deps: CreateDentalRuntimeAgentDeps): OpenAIRuntimeAgent {
  const caller = createOpenAIRuntimeAgentCaller({ client: deps.openaiClient });

  const knowledgeRepository = createSupabaseKnowledgeRepository({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
  });

  const kbExecutor = createKbSearchExecutor({ knowledgeRepository });
  const availabilityExecutor = deps.clinicCardAvailabilityExecutor ?? createClinicCardAvailabilityExecutor();

  const executors = {
    "kb.search": kbExecutor,
    "availability.check": availabilityExecutor,
  };

  return createRuntimeAgentLoop({
    model: deps.model,
    caller,
    executors,
    conversationMemoryRepository: deps.conversationMemoryRepository,
    now: deps.now,
  });
}
