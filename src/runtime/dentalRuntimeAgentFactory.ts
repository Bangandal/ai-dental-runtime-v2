import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import { createRuntimeAgentWithBookingContactBridge } from "./runtimeBookingContactAgent.ts";
import { createOpenAIRuntimeAgentCaller, type OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import { createSupabaseKnowledgeRepository, type EmbeddingClient, type RpcCaller } from "./supabaseKnowledgeRepository.ts";
import { createKbSearchExecutor } from "./kbSearchExecutor.ts";
import { createClinicCardAvailabilityExecutor } from "../integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import { createBookingApplyExecutor } from "../integrations/cliniccard/bookingApplyExecutor.ts";
import { createAppointmentLookupExecutor } from "../integrations/cliniccard/appointmentLookupExecutor.ts";
import type { ToolExecutor } from "./toolExecutor.ts";
import type { OpenAIRuntimeAgent } from "./openaiRuntimeAgent.ts";
import type { BookingProcessStateRepository } from "./bookingProcessState.ts";
import { createBookingReconciliationCoordinator } from "./bookingReconciliationCoordinator.ts";

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

  const knowledgeRepository = createSupabaseKnowledgeRepository({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
  });

  const reconciliationCoordinator = deps.bookingProcessStateRepository
    ? createBookingReconciliationCoordinator(deps.bookingProcessStateRepository)
    : undefined;

  const kbExecutor = createKbSearchExecutor({ knowledgeRepository });
  const availabilityExecutor = deps.clinicCardAvailabilityExecutor ?? createClinicCardAvailabilityExecutor();
  const bookingExecutor = deps.bookingApplyExecutor ?? createBookingApplyExecutor({
    bookingReconciliationGuard: reconciliationCoordinator?.guard,
  });
  const lookupExecutor = deps.appointmentLookupExecutor ?? createAppointmentLookupExecutor();

  const executors = {
    "kb.search": kbExecutor,
    "availability.check": availabilityExecutor,
    "booking.apply": bookingExecutor,
    "appointment.lookup": lookupExecutor,
  };

  return createRuntimeAgentWithBookingContactBridge({
    model: deps.model,
    caller,
    executors,
    conversationMemoryRepository: deps.conversationMemoryRepository,
    bookingProcessStateRepository: reconciliationCoordinator?.stateRepository ?? deps.bookingProcessStateRepository,
    now: deps.now,
    timezone: deps.timezone,
  });
}
