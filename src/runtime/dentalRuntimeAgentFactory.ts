import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import { createRuntimeAgentWithBookingContactBridge } from "./runtimeBookingContactAgent.ts";
import { createOpenAIRuntimeAgentCaller, type OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { EmbeddingClient, RpcCaller } from "./supabaseKnowledgeRepository.ts";
import type { ToolExecutor } from "./toolExecutor.ts";
import type { OpenAIRuntimeAgent } from "./openaiRuntimeAgent.ts";
import type { BookingProcessStateRepository } from "./bookingProcessState.ts";
import { createDentalToolKernel } from "./dentalToolExecutors.ts";

export interface CreateDentalRuntimeAgentDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  conversationMemoryRepository?: ConversationMemoryRepository;
  bookingProcessStateRepository?: BookingProcessStateRepository;
  now?: Date;
  timezone?: string;
  clinicCardAvailabilityExecutor?: ToolExecutor;
  bookingApplyExecutor?: ToolExecutor;
  appointmentLookupExecutor?: ToolExecutor;
}

/**
 * Stateful Responses calls mutate the OpenAI conversation thread. Retrying the same
 * logical call inside the SDK is unsafe because an earlier attempt may have reached
 * OpenAI and emitted a function_call even when Runtime never received its response.
 * A later retry can then fail with 429 and make the thread look clean when it is not.
 *
 * Keep the shared client retry policy for stateless/background OpenAI operations, but
 * force exactly one HTTP attempt for the dental agent's stateful responses.create call.
 */
export function createStatefulAgentResponsesClient(client: OpenAIResponsesClient): OpenAIResponsesClient {
  type StatefulResponsesCreate = (
    input: unknown,
    options?: { maxRetries?: number } & Record<string, unknown>,
  ) => Promise<unknown>;

  const create = client.responses.create as StatefulResponsesCreate;
  return {
    responses: {
      create(input: unknown): Promise<unknown> {
        return create.call(client.responses, input, { maxRetries: 0 });
      },
    },
  };
}

export function createDentalRuntimeAgent(deps: CreateDentalRuntimeAgentDeps): OpenAIRuntimeAgent {
  const caller = createOpenAIRuntimeAgentCaller({
    client: createStatefulAgentResponsesClient(deps.openaiClient),
  });

  const kernel = createDentalToolKernel({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
    bookingProcessStateRepository: deps.bookingProcessStateRepository,
    clinicCardAvailabilityExecutor: deps.clinicCardAvailabilityExecutor,
    bookingApplyExecutor: deps.bookingApplyExecutor,
    appointmentLookupExecutor: deps.appointmentLookupExecutor,
  });

  return createRuntimeAgentWithBookingContactBridge({
    model: deps.model,
    caller,
    executors: kernel.executors,
    conversationMemoryRepository: deps.conversationMemoryRepository,
    bookingProcessStateRepository: kernel.bookingProcessStateRepository,
    now: deps.now,
    timezone: deps.timezone,
  });
}
