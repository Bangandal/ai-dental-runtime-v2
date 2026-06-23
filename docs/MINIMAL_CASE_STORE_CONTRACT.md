# Minimal Case Store Contract

## 1. Core Principle

Runtime Core owns case state. The case store is the persistence boundary for that ownership.

- Cases are persisted and mutated only through `CaseRepository`.
- `CaseRepository` calls existing Supabase/Core RPC functions — it does not implement transactional case logic in TypeScript.
- If an existing RPC is not suitable, a gap is recorded here and confirmed with the owner before any new RPC is written.
- No SQL schema changes are defined in this document. Schema is owned by the core DB layer.

This contract defines: what fields a case must carry, what operations `CaseRepository` must expose, and how those operations map to existing RPC candidates.

---

## 2. Minimal Case Record

A case record must carry the following fields for MVP.

### Identity Fields (required, set at open, immutable after set)

| Field | Type | Description |
|---|---|---|
| `case_id` | `string` (UUID) | Unique case identifier. Owned by Runtime Core. |
| `clinic_id` | `string` | The clinic this case belongs to. |
| `contact_id` | `string` | The contact who initiated this case. |
| `conversation_id` | `string` | The conversation this case is associated with. |
| `case_kind` | `CaseKind` | Operational type: `booking_intake`, `reschedule`, `cancel`, `admin_handoff`, `process_status`, `urgent`. Set at open. **Not silently mutable.** See Section 4 for reclassification rules. |

### Subject Fields (updatable via `mergeCaseState`)

| Field | Type | Description |
|---|---|---|
| `subject_kind` | `SubjectKind` | Who the case is about: `self`, `friend`, `child`, `partner`, `other`. |
| `subject_display_name` | `string \| null` | Display name of the subject if provided by patient. |
| `subject_relation` | `string \| null` | Free-text relation (e.g. "son", "wife"). |

### Operational Fields (updatable via `mergeCaseState`)

| Field | Type | Description |
|---|---|---|
| `service_interest` | `string \| null` | Type of service requested (cleaning, implant, whitening, etc.). |
| `preferred_date` | `string \| null` | Patient's stated preferred date. |
| `preferred_time` | `string \| null` | Patient's stated preferred time. |
| `urgency` | `boolean` | Whether urgency was declared. Default: `false`. |
| `handoff_reason` | `string \| null` | Why a handoff was proposed (admin request, urgency, unsupported service). |
| `notes` | `string \| null` | Additional operational notes on the case. |

### Lifecycle Fields (managed by Runtime Core)

| Field | Type | Description |
|---|---|---|
| `status` | `CaseStatus` | Current lifecycle state. See Section 3. |
| `outcome` | `CaseOutcome \| null` | Terminal result. Set only at case closure. Immutable after set. |
| `created_at` | `timestamp` | When the case was opened. |
| `updated_at` | `timestamp` | When the case was last updated. |
| `closed_at` | `timestamp \| null` | When the case was closed. Null until terminal outcome. |

---

## 3. CaseKind, Status, and Outcome Types

These types are defined in the Case Logic Contract. Repeated here for reference only.

### CaseKind

`booking_intake` | `reschedule` | `cancel` | `admin_handoff` | `process_status` | `urgent`

### CaseStatus

`collecting` | `ready_for_action` | `action_in_progress` | `handoff` | `closed` | `cancelled` | `expired`

### CaseOutcome

`booked` | `handed_off` | `cancelled_by_patient` | `unsupported_service` | `abandoned` | `answered` | `failed` | `duplicate` | `expired`

---

## 4. case_kind Reclassification and Duplicate Prevention

### case_kind Reclassification

`case_kind` is set at open and is normally immutable. It must not be silently changed through `mergeCaseState`.

If Runtime Core determines that the operational meaning of a conversation has changed (e.g., a status inquiry evolves into a booking request), it must choose one of two explicit paths:

**Option A — Open a new case.**
Close or leave the prior case open, and open a new case with the correct `case_kind`. This is the preferred path for MVP. It produces a clean audit trail.

**Option B — Explicit audited reclassification.**
Call a dedicated reclassification operation (not covered in this MVP contract) that records a `case_kind_changed` event before updating the field. This path requires an explicit `appendCaseEvent` call with `event_kind: case_kind_changed`, the old value, the new value, and the reason. This option is deferred to a future contract unless the owner explicitly requests it.

Silent `case_kind` mutation via generic `mergeCaseState` is not allowed under either path.

---

### Duplicate and Multi-Case Rules

Runtime Core must prevent duplicate active cases for the same identity key:

- `contact_id`
- `conversation_id`
- `case_kind`
- subject identity (`subject_kind` + `subject_display_name` when available)

Before calling `openCase`, Runtime Core must call `findActiveCase` with the full identity key. If a matching case exists, it must resume that case rather than open a duplicate.

**Multiple active cases per conversation are explicitly allowed when subjects differ.**

Example:

| contact_id | conversation_id | case_kind | subject_kind | subject_display_name |
|---|---|---|---|---|
| mikhail_001 | conv_abc | `booking_intake` | `self` | Mikhail |
| mikhail_001 | conv_abc | `booking_intake` | `friend` | Vasya |

These are two distinct valid active cases. They must not overwrite each other. `findActiveCase` must use the full identity key to distinguish them.

---

## 5. CaseRepository Interface (Minimal MVP)

`CaseRepository` is the only allowed path for reading and writing case state. Runtime Core executors call `CaseRepository` methods; they do not call Supabase RPC directly.

### `openCase(input: OpenCaseInput): Promise<Case>`

Opens a new case. Called when Runtime Core determines that a conversation requires an operational case.

Input must include: `clinic_id`, `contact_id`, `conversation_id`, `case_kind`, `subject_kind`.
Optional: `service_interest`, `urgency`, `notes`.

Returns the persisted case record.

---

### `mergeCaseState(case_id: string, patch: CaseStatePatch): Promise<Case>`

Updates mutable case fields. Called when the Patient Agent proposes a case update and Runtime Core validates it.

`CaseStatePatch` may include any subset of: `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `status`.

**`case_kind` is not a normal patch field.** It must not be silently mutated through `mergeCaseState`. See Section 4 (case_kind reclassification) for the allowed path when operational meaning changes.

Returns the updated case record.

Corresponds to: `rpc_apply_case_decision_v1` (candidate — confirm input shape and merge behavior against live DB before implementation).

---

### `appendCaseEvent(case_id: string, event: CaseEvent): Promise<void>`

Appends an immutable event to the case audit log. Called for every significant case lifecycle transition or agent action.

Minimum event fields: `event_kind`, `actor` (`patient_agent`, `runtime_core`, `operator`), `timestamp`, `payload` (optional structured data).

Corresponds to: `rpc_log_case_event` or equivalent event RPC (confirm presence and signature in live DB before implementation).

---

### `getActiveCases(contact_id: string, conversation_id: string): Promise<Case[]>`

Returns all non-terminal cases for this contact and conversation.

One conversation may produce multiple active cases when subjects differ (e.g., a patient booking for themselves and a friend). This method must return all of them, not only the most recent.

Used by Runtime Core to determine whether to open a new case or resume an existing one.

Corresponds to: `rpc_get_contact_case_context_v1` (candidate — confirm that it returns all active cases, not only the most recent single record; adapter normalization required if RPC returns a single row).

---

### `findActiveCase(input: FindActiveCaseInput): Promise<Case | null>`

Returns a specific non-terminal case matching the given identity key, or `null` if none exists.

`FindActiveCaseInput` must include:
- `contact_id`
- `conversation_id`
- `case_kind`
- `subject_kind`
- `subject_display_name` (optional — used when subject identity is known)

Used by Runtime Core to locate an existing case before deciding to open a new one for the same subject and intent.

Corresponds to: `rpc_get_contact_case_context_v1` with filtered lookup (candidate — confirm filtering capability or implement as client-side filter over `getActiveCases` result).

---

### `closeCase(case_id: string, outcome: CaseOutcome): Promise<Case>`

Sets the case to a terminal status and records the final outcome. Immutable after set.

Sets: `status = closed` (or `cancelled` / `expired` as appropriate), `outcome`, `closed_at`.

Returns the closed case record.

Corresponds to: `rpc_apply_case_decision_v1` with a terminal transition (confirm that this RPC supports terminal outcome recording).

---

## 6. RPC Candidate Mapping

| CaseRepository method | Candidate existing RPC | Status | Action required |
|---|---|---|---|
| `openCase` | `rpc_apply_case_decision_v1` | Candidate | Confirm input shape supports initial open |
| `mergeCaseState` | `rpc_apply_case_decision_v1` | Candidate | Confirm state merge contract; check for hidden semantic routing; confirm `case_kind` is not patchable through this path |
| `appendCaseEvent` | `rpc_log_case_event` | Candidate | Confirm presence and signature in live DB |
| `getActiveCases` | `rpc_get_contact_case_context_v1` | Candidate | Confirm it returns all active cases (not only single most recent); adapter normalization required if single-row RPC |
| `findActiveCase` | `rpc_get_contact_case_context_v1` (filtered) | Candidate | Confirm filtering by `case_kind` + subject identity; or implement as client-side filter over `getActiveCases` |
| `closeCase` | `rpc_apply_case_decision_v1` | Candidate | Confirm terminal transition support |

**Do not implement `CaseRepository` against these RPCs until each candidate has been confirmed against the live core schema.** If a candidate is unsuitable, a gap must be recorded and the owner must approve a new RPC before any schema change is made.

---

## 7. What This Contract Does Not Define

- SQL table or column definitions (owned by core DB layer).
- Concrete Supabase RPC function signatures (must be confirmed against live DB).
- `BookingRepository` or availability/hold operations (separate contract, depends on CRM adapter).
- Admin notification persistence (covered in Admin Notification / Handoff Contract).
- Case expiration job or abandonment job (scheduled job, separate scope).
- Patient Agent prompt changes.
- Deployment or migration steps.

---

## 8. CRM-Blocked State


The case store is available before the CRM adapter exists.

| Operation | Available before CRM | Notes |
|---|---|---|
| `openCase` | ✅ Yes | |
| `mergeCaseState` | ✅ Yes | |
| `appendCaseEvent` | ✅ Yes | |
| `getActiveCases` | ✅ Yes | |
| `findActiveCase` | ✅ Yes | |
| `closeCase` with `outcome: handed_off` | ✅ Yes | |
| `closeCase` with `outcome: booked` | ❌ No | Only after `booking.apply` succeeds via CRM adapter |

No case may reach `outcome: booked` without a confirmed `booking.apply` backend result.

---

## 9. Permission Model


| Action | Class | Who may perform |
|---|---|---|
| Open, update, close case | Runtime Core executor via `CaseRepository` | Runtime Core only |
| Propose case update | Proposal | Patient Agent (via `case.upsert` tool → Runtime Core validates) |
| Read case state | Read-only | Operator Agent, Patient Agent (via runtime tools) |
| Modify DB schema or RPC | Protected | Owner approval required before any change |
| Confirm RPC candidate suitability | Required before implementation | Owner / DB administrator |

---

## Acceptance

After this document exists, a developer should be able to answer:

**What fields does a case carry at minimum?**
Identity fields (`case_id`, `clinic_id`, `contact_id`, `conversation_id`, `case_kind`), subject fields, operational fields (`service_interest`, `preferred_date`, `urgency`, `handoff_reason`, `notes`), and lifecycle fields (`status`, `outcome`, timestamps).

**What is the only allowed path to read or write case state?**
`CaseRepository`. Executors do not call Supabase RPC directly.

**What RPC candidates exist for case persistence?**
`rpc_apply_case_decision_v1` (open/merge/close), `rpc_log_case_event` (events), `rpc_get_contact_case_context_v1` (read active cases). All candidates must be confirmed against the live DB before implementation.

**Can case_kind be changed through mergeCaseState?**
No. `case_kind` is set at open and is not a normal patch field. To change operational meaning, Runtime Core must either open a new case (preferred) or perform an explicit audited reclassification (future).

**Can multiple active cases exist in one conversation?**
Yes. One conversation may have multiple active cases when subjects differ (e.g., Mikhail/self and Vasya/friend). `getActiveCases` returns all of them. `findActiveCase` uses the full identity key (contact_id + conversation_id + case_kind + subject) to locate a specific one. They must not overwrite each other.

**What requires owner approval before implementation begins?**
Confirming RPC candidate suitability. Any gap that requires a new RPC or schema change requires owner approval before any change is made.

**What is not covered here?**
SQL schema, concrete RPC signatures, booking/hold operations, admin notification persistence, case expiration jobs, and deployment steps.
