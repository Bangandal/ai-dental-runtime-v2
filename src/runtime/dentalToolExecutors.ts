import { createSupabaseKnowledgeRepository, type EmbeddingClient, type RpcCaller } from "./supabaseKnowledgeRepository.ts";
import { createKbSearchExecutor } from "./kbSearchExecutor.ts";
import { createClinicCardAvailabilityExecutor } from "../integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import { createBookingApplyExecutor } from "../integrations/cliniccard/bookingApplyExecutor.ts";
import { createAppointmentLookupExecutor } from "../integrations/cliniccard/appointmentLookupExecutor.ts";
import type { ToolExecutor, ToolExecutorRegistry } from "./toolExecutor.ts";
import type { BookingProcessStateRepository } from "./bookingProcessState.ts";
import { createBookingReconciliationCoordinator } from "./bookingReconciliationCoordinator.ts";

export interface CreateDentalToolKernelDeps {
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  bookingProcessStateRepository?: BookingProcessStateRepository;
  clinicCardAvailabilityExecutor?: ToolExecutor;
  bookingApplyExecutor?: ToolExecutor;
  appointmentLookupExecutor?: ToolExecutor;
}

export interface DentalToolKernel {
  executors: ToolExecutorRegistry;
  /** Lock-preserving state repository. Always use this alongside these executors. */
  bookingProcessStateRepository?: BookingProcessStateRepository;
}

/**
 * Build the single deterministic tool kernel used by every conversation surface.
 * The reconciliation wrapper and booking writer are created together so no caller can
 * accidentally persist visible booking state over a hidden write-reconciliation lock.
 */
export function createDentalToolKernel(
  deps: CreateDentalToolKernelDeps,
): DentalToolKernel {
  const knowledgeRepository = createSupabaseKnowledgeRepository({
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    embeddingModel: deps.embeddingModel,
  });

  const reconciliationCoordinator = deps.bookingProcessStateRepository
    ? createBookingReconciliationCoordinator(deps.bookingProcessStateRepository)
    : undefined;

  return {
    executors: {
      "kb.search": createKbSearchExecutor({ knowledgeRepository }),
      "availability.check": deps.clinicCardAvailabilityExecutor ?? createClinicCardAvailabilityExecutor(),
      "booking.apply": deps.bookingApplyExecutor ?? createBookingApplyExecutor({
        bookingReconciliationGuard: reconciliationCoordinator?.guard,
      }),
      "appointment.lookup": deps.appointmentLookupExecutor ?? createAppointmentLookupExecutor(),
    },
    bookingProcessStateRepository:
      reconciliationCoordinator?.stateRepository ?? deps.bookingProcessStateRepository,
  };
}
