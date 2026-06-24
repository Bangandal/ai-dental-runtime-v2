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
  type Case,
  type CaseKind,
  type CaseOutcome,
  type CaseStatus,
  type FindActiveCaseInput,
  type SubjectKind,
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

  return { getActiveCases, findActiveCase };
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
