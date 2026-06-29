import type { ToolDecision, ToolName } from "./toolPolicy.ts";

export type ToolExecutionStatus = "success" | "failed" | "not_implemented";

export interface ToolExecutionBase {
  tool: ToolName;
  status: ToolExecutionStatus;
  trace_id?: string;
}

export type ToolExecutionError = {
  code: string;
  message: string;
  retryable: boolean;
};

export interface KbSearchSuccessResult extends ToolExecutionBase {
  tool: "kb.search";
  status: "success";
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

export interface AvailabilityCheckSuccessResult extends ToolExecutionBase {
  tool: "availability.check";
  status: "success";
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
    total_slots?: number;
    free_slots_count?: number;
  };
}

export interface HoldCreateSuccessResult extends ToolExecutionBase {
  tool: "hold.create";
  status: "success";
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

export interface BookingConfirmSuccessResult extends ToolExecutionBase {
  tool: "booking.confirm";
  status: "success";
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

export interface CancelHoldSuccessResult extends ToolExecutionBase {
  tool: "cancel_hold";
  status: "success";
  data: {
    hold_id: string;
    status: "cancelled";
    reason?: string;
  };
}

export type BookingApplyStatus =
  | "booking_write_disabled"
  | "missing_phone"
  | "config_missing"
  | "slot_conflict"
  | "cliniccard_write_failed"
  | "visit_created";

export interface BookingApplyResult {
  booking_action: "booking_apply";
  booking_status: BookingApplyStatus;
  created_visit: boolean;
  may_claim_booked: boolean;
  cliniccard_visit_id: string | null;
  cliniccard_patient_id?: number;
  date?: string;
  time_start?: string;
  time_end?: string;
  doctor_id?: number;
  cabinet_id?: number;
  timezone?: string;
  reason: string;
  proof: Record<string, unknown> | null;
}

export interface BookingApplySuccessResult extends ToolExecutionBase {
  tool: "booking.apply";
  status: "success";
  data: BookingApplyResult;
}

export interface AppointmentMutateNotImplementedResult extends ToolExecutionBase {
  tool: "appointment.mutate";
  status: "not_implemented";
  data?: null;
  error?: {
    code: "tool_not_implemented";
    message: string;
    retryable: false;
  };
}

export type ToolSuccessResult =
  | KbSearchSuccessResult
  | AvailabilityCheckSuccessResult
  | HoldCreateSuccessResult
  | BookingConfirmSuccessResult
  | CancelHoldSuccessResult
  | BookingApplySuccessResult;

export interface ToolFailedResult extends ToolExecutionBase {
  tool: ToolName;
  status: "failed";
  error: ToolExecutionError;
  data?: null;
}

export interface ToolNotImplementedResult extends ToolExecutionBase {
  tool: ToolName;
  status: "not_implemented";
  error?: {
    code: "tool_not_implemented";
    message: string;
    retryable: false;
  };
  data?: null;
}

export type ToolExecutionResult = ToolSuccessResult | ToolFailedResult | ToolNotImplementedResult;

export interface ToolExecutionPlan {
  tools_allowed: ToolName[];
  policy_denials: ToolDecision[];
}

export function makeNotImplementedToolResult(tool: ToolName): ToolNotImplementedResult {
  return {
    tool,
    status: "not_implemented",
    error: {
      code: "tool_not_implemented",
      message: `${tool} is not implemented`,
      retryable: false,
    },
    data: null,
  };
}

export function makeFailedToolResult(
  tool: ToolName,
  code: string,
  message: string,
  retryable = false,
): ToolFailedResult {
  return {
    tool,
    status: "failed",
    error: {
      code,
      message,
      retryable,
    },
    data: null,
  };
}
