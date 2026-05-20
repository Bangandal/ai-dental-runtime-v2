import type { ToolDecision, ToolName } from "./toolPolicy.ts";

export type ToolExecutionStatus = "success" | "denied" | "failed" | "not_implemented";

export interface ToolExecutionBase {
  tool: ToolName;
  status: ToolExecutionStatus;
  trace_id?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface KbSearchResult extends ToolExecutionBase {
  tool: "kb.search";
  status: "success" | "failed";
  data: {
    query?: string;
    chunks: Array<{
      chunk_id: string;
      document_id?: string;
      score?: number;
      text: string;
      metadata?: Record<string, unknown>;
    }>;
  };
}

export interface AvailabilityCheckResult extends ToolExecutionBase {
  tool: "availability.check";
  status: "success" | "failed";
  data: {
    slots: Array<{
      slot_id: string;
      starts_at: string;
      ends_at: string;
      provider_id?: string | null;
      location_id?: string | null;
      service_id?: string | null;
    }>;
    timezone?: string;
    provider?: string | null;
  };
}

export interface HoldCreateResult extends ToolExecutionBase {
  tool: "hold.create";
  status: "success" | "failed";
  data: {
    hold_id: string;
    slot_id: string;
    starts_at: string;
    ends_at: string;
    expires_at: string;
    contact_id: string;
    case_id: string;
  };
}

export interface BookingConfirmResult extends ToolExecutionBase {
  tool: "booking.confirm";
  status: "success" | "failed";
  data: {
    appointment_id: string;
    hold_id: string;
    contact_id: string;
    case_id: string;
    starts_at: string;
    ends_at: string;
    status: "booked_pending_admin_confirmation" | "booked_confirmed";
  };
}

export interface CancelHoldResult extends ToolExecutionBase {
  tool: "cancel_hold";
  status: "success" | "failed";
  data: {
    hold_id: string;
    status: "cancelled";
    reason?: string;
  };
}

export interface AppointmentMutateResult extends ToolExecutionBase {
  tool: "appointment.mutate";
  status: "not_implemented";
  data?: null;
}

export type ToolExecutionResult =
  | KbSearchResult
  | AvailabilityCheckResult
  | HoldCreateResult
  | BookingConfirmResult
  | CancelHoldResult
  | AppointmentMutateResult;

export interface ToolExecutionPlan {
  tools_allowed: ToolName[];
  policy_denials: ToolDecision[];
}

export function makeNotImplementedToolResult(tool: ToolName): ToolExecutionResult {
  if (tool === "appointment.mutate") {
    return { tool, status: "not_implemented", data: null };
  }

  return {
    tool,
    status: "failed",
    error: {
      code: "tool_not_implemented",
      message: `${tool} is not implemented`,
      retryable: false,
    },
  } as ToolExecutionResult;
}

export function makeFailedToolResult(
  tool: ToolName,
  code: string,
  message: string,
  retryable = false,
): ToolExecutionResult {
  return {
    tool,
    status: "failed",
    error: {
      code,
      message,
      retryable,
    },
  } as ToolExecutionResult;
}
