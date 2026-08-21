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

export function createDentalRuntimeAgent(deps: CreateDentalRuntimeAgentDeps): OpenAIRuntimeAgent {
  const caller = createOpenAIRuntimeAgentCaller({ client: deps.openaiClient });

  const knowledgeRepository = createSupabaseKnowledgeRepository({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
  });

  const kbExecutor = createKbSearchExecutor({ knowledgeRepository });
  const availabilityExecutor = deps.clinicCardAvailabilityExecutor ?? createClinicCardAvailabilityExecutor();
  const bookingExecutor = deps.bookingApplyExecutor ?? createBookingApplyExecutor();
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
    bookingProcessStateRepository: deps.bookingProcessStateRepository,
    now: deps.now,
    timezone: deps.timezone,
  });
}
