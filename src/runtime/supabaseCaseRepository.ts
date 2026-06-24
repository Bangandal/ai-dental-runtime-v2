/**
 * CaseRepository — read path (getActiveCases + findActiveCase).
 *
 * Implements the logical Case contract defined in docs/MINIMAL_CASE_STORE_CONTRACT.md
 * against the physical Supabase/Core RPC layer documented in
 * docs/RPC_CANDIDATE_VERIFICATION_REPORT.md.
 *
 * Write methods (openCase, mergeCaseState, closeCase, appendCaseEvent) are
 * deferred to a subsequent PR after this read path is accepted.
 */

import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";
import {
  type AppendCaseEventInput,
  type Case,
  type CaseKind,
  type CaseOutcome,
  type CaseStatus,
  type FindActiveCaseInput,
  type OpenCaseInput,
  type SubjectKind,
  caseKindToPhysicalType,
  physicalCaseTypeToKind,
} from "./case.ts";

export interface CaseRepository {
  /**
   * Returns all non-terminal active cases for the given clinic, contact, and
   * conversation. Calls rpc_get_contact_case_context_v1 (clinic/contact scoped)
   * and filters the open_cases array by conversation_id stored in collected/meta.
   */
  getActiveCases(
    clinic_id: string,
    contact_id: string,
    conversation_id: string,
  ): Promise<RuntimeResult<Case[]>>;

  /**
   * Returns the first active case matching the full identity key, or null.
   * Delegates to getActiveCases and filters client-side by case_kind,
   * subject_kind, and subject_display_name.
   */
  findActiveCase(input: FindActiveCaseInput): Promise<RuntimeResult<Case | null>>;

  /**
   * Opens a new case via rpc_apply_case_decision_v1(open_case).
   * Stores all logical fields absent from the physical schema in collected jsonb.
   * Performs a follow-up getActiveCases read to return a fully normalized Case.
   * Does not create appointments. Does not set outcome=booked.
   */
  openCase(input: OpenCaseInput): Promise<RuntimeResult<Case>>;

  /**
   * Appends an audit event to a case via rpc_log_case_event.
   * Append-only. Does not mutate case state.
   */
  appendCaseEvent(input: AppendCaseEventInput): Promise<RuntimeResult<void>>;
}

export function createSupabaseCaseRepository(deps: { rpc: RpcCaller }): CaseRepository {
  async function getActiveCases(
    clinic_id: string,
    contact_id: string,
    conversation_id: string,
  ): Promise<RuntimeResult<Case[]>> {
    const response = await deps.rpc<unknown[]>("rpc_get_contact_case_context_v1", {
      p_clinic_id: clinic_id,
      p_contact_id: contact_id,
      p_limit: 50,
    });

    if (response.error) {
      return {
        ok: false,
        error: {
          code: "case_context_load_failed",
          message: String((response.error as { message?: string } | null)?.message ?? response.error),
          retryable: true,
        },
      };
    }

    const row = Array.isArray(response.data) ? (response.data[0] ?? {}) : {};
    const rawOpenCases = asArray((row as Record<string, unknown>).open_cases);

    const cases: Case[] = rawOpenCases.map((raw) =>
      normalizeCaseRow(raw, clinic_id, contact_id),
    );

    // Filter by conversation_id. The RPC is clinic/contact scoped only; adapter
    // filters to the current conversation via collected/meta stored value.
    const filtered = cases.filter((c) => c.conversation_id === conversation_id);

    return { ok: true, data: filtered };
  }

  async function findActiveCase(
    input: FindActiveCaseInput,
  ): Promise<RuntimeResult<Case | null>> {
    const result = await getActiveCases(
      input.clinic_id,
      input.contact_id,
      input.conversation_id,
    );
    if (!result.ok) return result;

    const match = result.data.find((c) => {
      if (c.case_kind !== input.case_kind) return false;
      if (c.subject_kind !== input.subject_kind) return false;
      if (
        input.subject_display_name !== undefined &&
        c.subject_display_name !== input.subject_display_name
      ) {
        return false;
      }
      return true;
    });

    return { ok: true, data: match ?? null };
  }

  async function openCase(input: OpenCaseInput): Promise<RuntimeResult<Case>> {
    // Build collected jsonb — all logical fields missing from the physical schema.
    // collected is canonical for new writes; outcome is explicitly null at open time.
    const collected: Record<string, unknown> = {
      conversation_id: input.conversation_id,
      subject_kind: input.subject_kind,
      subject_display_name: input.subject_display_name ?? null,
      subject_relation: input.subject_relation ?? null,
      service_interest: input.service_interest ?? null,
      preferred_date: input.preferred_date ?? null,
      preferred_time: input.preferred_time ?? null,
      urgency: input.urgency ?? false,
      notes: input.notes ?? null,
      handoff_reason: null,
      outcome: null,
    };

    const openResponse = await deps.rpc<unknown[]>("rpc_apply_case_decision_v1", {
      p_clinic_id: input.clinic_id,
      p_contact_id: input.contact_id,
      p_case_action: "open_case",
      p_case_type: caseKindToPhysicalType(input.case_kind),
      p_collected: collected,
    });

    if (openResponse.error) {
      return {
        ok: false,
        error: {
          code: "case_open_failed",
          message: String(
            (openResponse.error as { message?: string } | null)?.message ?? openResponse.error,
          ),
          retryable: true,
        },
      };
    }

    // Extract case_id from the RPC response if the shape provides it.
    // rpc_apply_case_decision_v1 response shape is not guaranteed — fall back
    // to identity-key matching in the follow-up read if case_id is missing.
    const responseRow = Array.isArray(openResponse.data)
      ? (openResponse.data[0] ?? {})
      : (openResponse.data ?? {});
    const rawCaseId =
      (responseRow as Record<string, unknown>).case_id ??
      (responseRow as Record<string, unknown>).id;

    // Follow-up read: getActiveCases already applies full normalization.
    // This is the safest path regardless of what the write RPC returns.
    const readResult = await getActiveCases(
      input.clinic_id,
      input.contact_id,
      input.conversation_id,
    );
    if (!readResult.ok) {
      return {
        ok: false,
        error: {
          code: "case_open_read_back_failed",
          message: `Case RPC succeeded but follow-up read failed: ${readResult.error.message}`,
          retryable: true,
        },
      };
    }

    // Prefer matching by case_id from the RPC response; fall back to identity key.
    const opened = rawCaseId
      ? readResult.data.find((c) => c.case_id === String(rawCaseId))
      : readResult.data.find(
          (c) =>
            c.case_kind === input.case_kind &&
            c.subject_kind === input.subject_kind &&
            (input.subject_display_name === undefined ||
              c.subject_display_name === input.subject_display_name),
        );

    if (!opened) {
      return {
        ok: false,
        error: {
          code: "case_open_not_found_after_write",
          message:
            `openCase RPC succeeded but the opened case could not be located in subsequent ` +
            `getActiveCases. case_kind=${input.case_kind} subject_kind=${input.subject_kind} ` +
            `rawCaseId=${rawCaseId ?? "unknown"}`,
          retryable: false,
        },
      };
    }

    return { ok: true, data: opened };
  }

  async function appendCaseEvent(
    input: AppendCaseEventInput,
  ): Promise<RuntimeResult<void>> {
    // rpc_log_case_event signature confirmed from live schema inspection:
    // p_clinic_id, p_contact_id, p_case_id, p_event_type, p_event_source,
    // p_trace_id, p_message_id, p_lead_id, p_notification_id, p_payload.
    const args: Record<string, unknown> = {
      p_clinic_id: input.clinic_id,
      p_contact_id: input.contact_id,
      p_case_id: input.case_id,
      p_event_type: input.event_kind,
      p_event_source: input.actor,
      p_payload: input.payload ?? {},
    };
    if (input.trace_id !== undefined) args.p_trace_id = input.trace_id;
    if (input.message_id !== undefined) args.p_message_id = input.message_id;
    if (input.lead_id !== undefined) args.p_lead_id = input.lead_id;
    if (input.notification_id !== undefined) args.p_notification_id = input.notification_id;

    const response = await deps.rpc<unknown>("rpc_log_case_event", args);

    if (response.error) {
      return {
        ok: false,
        error: {
          code: "case_event_append_failed",
          message: String(
            (response.error as { message?: string } | null)?.message ?? response.error,
          ),
          retryable: true,
        },
      };
    }

    return { ok: true, data: undefined };
  }

  return { getActiveCases, findActiveCase, openCase, appendCaseEvent };
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw open_cases row to a logical Case.
 *
 * Throws a typed error if the row lacks both case_id and id — the caller must
 * not receive a Case without a case_id.
 */
function normalizeCaseRow(
  raw: unknown,
  clinic_id: string,
  contact_id: string,
): Case {
  const row = asRecord(raw);

  // case_id: use row.case_id first, fall back to row.id (RPC alias handling).
  const rawCaseId = row.case_id ?? row.id;
  if (rawCaseId === null || rawCaseId === undefined || rawCaseId === "") {
    throw new CaseRowMissingIdError(row);
  }
  const case_id = String(rawCaseId);

  const collected = asRecord(row.collected);
  const meta = asRecord(row.meta);

  // Helper: read jsonb field from collected first, meta as fallback.
  // Uses nullish coalescing so explicit null in collected also falls back to meta.
  const fromJsonb = (key: string): unknown => collected[key] ?? meta[key];

  return {
    case_id,
    clinic_id,
    contact_id,
    conversation_id: asNullableString(fromJsonb("conversation_id")),
    case_kind: physicalCaseTypeToKind(asNullableString(row.case_type)),
    subject_kind: asSubjectKind(fromJsonb("subject_kind")),
    subject_display_name: asNullableString(fromJsonb("subject_display_name")),
    subject_relation: asNullableString(fromJsonb("subject_relation")),
    service_interest: asNullableString(fromJsonb("service_interest")),
    preferred_date: asNullableString(fromJsonb("preferred_date")),
    preferred_time: asNullableString(fromJsonb("preferred_time")),
    urgency: Boolean(fromJsonb("urgency")),
    handoff_reason: asNullableString(fromJsonb("handoff_reason")),
    notes: asNullableString(fromJsonb("notes")),
    status: asCaseStatus(asNullableString(row.status)),
    outcome: asCaseOutcome(fromJsonb("outcome")),
    created_at: asNullableString(row.opened_at),
    updated_at: asNullableString(row.last_activity_at),
    closed_at: asNullableString(row.closed_at),
  };
}

export class CaseRowMissingIdError extends Error {
  readonly row: Record<string, unknown>;
  constructor(row: Record<string, unknown>) {
    super(
      "CaseRepository: open_cases row is missing both case_id and id. " +
        "This row cannot be normalized to a Case. Raw row: " +
        JSON.stringify(row),
    );
    this.name = "CaseRowMissingIdError";
    this.row = row;
  }
}

// ---------------------------------------------------------------------------
// Type coercions
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  // Some RPCs return a single object instead of an array.
  if (value && typeof value === "object") return [value];
  return [];
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const SUBJECT_KINDS: SubjectKind[] = ["self", "friend", "child", "partner", "other"];
function asSubjectKind(value: unknown): SubjectKind | null {
  if (typeof value === "string" && (SUBJECT_KINDS as string[]).includes(value)) {
    return value as SubjectKind;
  }
  return null;
}

const CASE_STATUSES: CaseStatus[] = [
  "collecting", "ready_for_action", "action_in_progress",
  "handoff", "closed", "cancelled", "expired",
];
function asCaseStatus(value: string | null): CaseStatus | null {
  if (value && (CASE_STATUSES as string[]).includes(value)) {
    return value as CaseStatus;
  }
  return null;
}

const CASE_OUTCOMES: CaseOutcome[] = [
  "booked", "handed_off", "cancelled_by_patient", "unsupported_service",
  "abandoned", "answered", "failed", "duplicate", "expired",
];
function asCaseOutcome(value: unknown): CaseOutcome | null {
  if (typeof value === "string" && (CASE_OUTCOMES as string[]).includes(value)) {
    return value as CaseOutcome;
  }
  return null;
}
