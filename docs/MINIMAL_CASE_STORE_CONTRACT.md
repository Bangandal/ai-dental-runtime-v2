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
| `case_kind` | `CaseKind` | Operational type: `booking_intake`, `reschedule`, `cancel`, `admin_handoff`, `process_status`, `urgent`. |

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

## 4. CaseRepository Interface (Minimal MVP)

`CaseRepository` is the only allowed path for reading and writing case state. Runtime Core executors call `CaseRepository` methods; they do not call Supabase RPC directly.

### `openCase(input: OpenCaseInput): Promise<Case>`

Opens a new case. Called when Runtime Core determines that a conversation requires an operational case.

Input must include: `clinic_id`, `contact_id`, `conversation_id`, `case_kind`, `subject_kind`.
Optional: `service_interest`, `urgency`, `notes`.

Returns the persisted case record.

---

### `mergeCaseState(case_id: string, patch: CaseStatePatch): Promise<Case>`

Updates mutable case fields. Called when the Patient Agent proposes a case update and Runtime Core validates it.

`CaseStatePatch` may include any subset of: `case_kind`, `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `status`.

Returns the updated case record.

Corresponds to: `rpc_apply_case_decision_v1` (candidate — confirm input shape and merge behavior against live DB before implementation).

---

### `appendCaseEvent(case_id: string, event: CaseEvent): Promise<void>`

Appends an immutable event to the case audit log. Called for every significant case lifecycle transition or agent action.

Minimum event fields: `event_kind`, `actor` (`patient_agent`, `runtime_core`, `operator`), `timestamp`, `payload` (optional structured data).

Corresponds to: `rpc_log_case_event` or equivalent event RPC (confirm presence and signature in live DB before implementation).

---

### `getActiveCase(contact_id: string, conversation_id: string): Promise<Case | null>`

Returns the most recent non-terminal case for this contact and conversation, or `null` if none exists.

Used by Runtime Core to determine whether to open a new case or resume an existing one.

Corresponds to: `rpc_get_contact_case_context_v1` (candidate — confirm that it returns active case state in the expected shape).

---

### `closeCase(case_id: string, outcome: CaseOutcome): Promise<Case>`

Sets the case to a terminal status and records the final outcome. Immutable after set.

Sets: `status = closed` (or `cancelled` / `expired` as appropriate), `outcome`, `closed_at`.

Returns the closed case record.

Corresponds to: `rpc_apply_case_decision_v1` with a terminal transition (confirm that this RPC supports terminal outcome recording).

---

## 5. RPC Candidate Mapping

| CaseRepository method | Candidate existing RPC | Status | Action required |
|---|---|---|---|
| `openCase` | `rpc_apply_case_decision_v1` | Candidate | Confirm input shape supports initial open |
| `mergeCaseState` | `rpc_apply_case_decision_v1` | Candidate | Confirm state merge contract; check for hidden semantic routing |
| `appendCaseEvent` | `rpc_log_case_event` | Candidate | Confirm presence and signature in live DB |
| `getActiveCase` | `rpc_get_contact_case_context_v1` | Candidate | Confirm output includes active case state; confirm subject support |
| `closeCase` | `rpc_apply_case_decision_v1` | Candidate | Confirm terminal transition support |

**Do not implement `CaseRepository` against these RPCs until each candidate has been confirmed against the live core schema.** If a candidate is unsuitable, a gap must be recorded and the owner must approve a new RPC before any schema change is made.

---

## 6. Multi-Case Boundary

One conversation may have more than one active case (e.g., patient books for themselves and a friend).

`getActiveCase` returns a single case for a given `(contact_id, conversation_id)` pair. If multiple cases are possible, the method signature may need to return `Case[]`. This is a known gap for MVP implementation — the owner must confirm expected behavior before implementation.

For MVP, assume at most one active case per conversation unless the owner directs otherwise.

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
| `getActiveCase` | ✅ Yes | |
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
`rpc_apply_case_decision_v1` (open/merge/close), `rpc_log_case_event` (events), `rpc_get_contact_case_context_v1` (read active case). All candidates must be confirmed against the live DB before implementation.

**What requires owner approval before implementation begins?**
Confirming RPC candidate suitability. Any gap that requires a new RPC or schema change requires owner approval before any change is made.

**What is not covered here?**
SQL schema, concrete RPC signatures, booking/hold operations, admin notification persistence, case expiration jobs, and deployment steps.
