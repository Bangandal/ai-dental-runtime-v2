import type { BookingRepository } from "./runtimeRepositories.ts";
import type { ToolExecutionContext, ToolExecutor } from "./toolExecutor.ts";
import { makeFailedToolResult } from "./toolResults.ts";

export interface AvailabilityCheckExecutorDeps {
  bookingRepository: Pick<BookingRepository, "checkAvailability">;
}

export function createAvailabilityCheckExecutor(
  deps: AvailabilityCheckExecutorDeps,
): ToolExecutor {
  return async (context: ToolExecutionContext) => {
    const clinicId = context.clinic_id;
    if (!clinicId) {
      return makeFailedToolResult(
        "availability.check",
        "availability_missing_clinic_id",
        "clinic_id is required",
        false,
      );
    }

    const requestedDate = context.requested_date;
    if (!requestedDate) {
      return makeFailedToolResult(
        "availability.check",
        "availability_missing_requested_date",
        "requested_date is required",
        false,
      );
    }

    const repositoryResult = await deps.bookingRepository.checkAvailability({
      clinic_id: clinicId,
      requested_date: requestedDate,
      requested_time: context.requested_time,
      service_interest: context.service_interest,
      timezone: context.timezone,
      limit: context.limit,
    });

    if (!repositoryResult.ok) {
      return makeFailedToolResult(
        "availability.check",
        repositoryResult.error.code,
        repositoryResult.error.message,
        repositoryResult.error.retryable,
      );
    }

    return {
      tool: "availability.check",
      status: "success",
      data: {
        slots: repositoryResult.data.slots,
        timezone: repositoryResult.data.timezone ?? undefined,
      },
    };
  };
}
