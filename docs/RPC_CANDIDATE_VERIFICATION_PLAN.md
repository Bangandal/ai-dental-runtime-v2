# RPC Candidate Verification Plan — Minimal Case Store

## 1. Purpose

Before implementing `CaseRepository` or `handoff.create`, all Supabase/Core RPC candidates that the Minimal Case Store Contract depends on must be confirmed against the live DB schema.

This document defines:
- Which RPC candidates require verification.
- What must be confirmed for each candidate.
- What evidence must be produced.
- What the dependency map between `CaseRepository` methods and RPC candidates looks like.
- What gates block implementation until verification is complete.

No schema changes, new RPC functions, or implementation code are defined here.

---

## 2. RPC Candidates to Verify

Three primary candidates support Minimal Case Store operations. A fourth candidate is included from `EXISTING_RPC_CAPABILITY_MATRIX.md` for completeness.

| Candidate RPC | Primary role |
|---|---|
| `rpc_apply_case_decision_v1` | Open, merge, and close case state |
| `rpc_get_contact_case_context_v1` | Read active cases for a contact/conversation |
| `rpc_log_case_event` (or equivalent) | Append immutable audit events to a case |
| `rpc_prepare_admin_notification` | Prepare notification intent (relevant to `handoff.create`) |

---

## 3. Per-RPC Candidate Analysis

### 3.1 `rpc_apply_case_decision_v1`

**Expected purpose**

Apply a case-level decision: open a new case, merge mutable case state, or record a terminal outcome. This is the write path for `openCase`, `mergeCaseState`, and `closeCase`.

**Expected input fields**

| Field | Required for | Notes |
|---|---|---|
| `p_clinic_id` | All operations | Clinic-scoped |
| `p_contact_id` | All operations | |
| `p_conversation_id` | All operations | |
| `p_case_id` | `mergeCaseState`, `closeCase` | Provided after open; absent or null for open |
| `p_case_kind` | `openCase` | Set at open — must not be patchable on update |
| `p_subject_kind` | `openCase`, `mergeCaseState` | |
| `p_subject_display_name` | Optional | Used for subject identity |
| `p_subject_relation` | Optional | |
| `p_status` | All transitions | Target lifecycle status |
| `p_outcome` | `closeCase` | Terminal outcome; null for non-terminal calls |
| `p_service_interest` | Optional | |
| `p_preferred_date` | Optional | |
| `p_preferred_time` | Optional | |
| `p_urgency` | Optional | |
| `p_handoff_reason` | Optional | |
| `p_notes` | Optional | |

**Expected output shape**

Returns the persisted case record after the operation. Minimum expected columns: `case_id`, `clinic_id`, `contact_id`, `conversation_id`, `case_kind`, `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `status`, `outcome`, `created_at`, `updated_at`, `closed_at`.

**CaseRepository methods that depend on this RPC**

`openCase`, `mergeCaseState`, `closeCase`

**Clinic-scoped?**

Must be. `p_clinic_id` must be a required parameter. Verification must confirm it is enforced and not optional.

**Supports multiple active cases per conversation?**

Depends on whether the RPC can operate on distinct `(clinic_id, contact_id, conversation_id, case_kind, subject)` combinations independently without overwriting a sibling case. Verification must confirm.

**Supports subject identity?**

Must confirm that `p_subject_kind` and `p_subject_display_name` are accepted and stored, not ignored.

**Supports terminal outcome?**

Must confirm that passing `p_outcome` with a terminal value (`booked`, `handed_off`, `cancelled_by_patient`, etc.) causes the case to reach a terminal status and that `closed_at` is set. Must confirm that outcome is immutable after set.

**Mutates case_kind?**

Must NOT allow `case_kind` to be changed through this RPC on a merge call. Verification must confirm that `p_case_kind` is either absent from the update path or ignored/rejected on update. If the RPC silently accepts `p_case_kind` on update and overwrites the field, that is a blocking gap.

**Logs audit events?**

Must confirm whether `rpc_apply_case_decision_v1` has any internal event side effects (e.g., auto-appends a `case_opened` or `case_updated` event). If it does, `appendCaseEvent` must not double-log those events. If it does not, `appendCaseEvent` must be called separately after each operation.

**Unknowns / gaps**

- Whether `p_case_id` is auto-generated or caller-supplied for `openCase`.
- Whether the RPC enforces unique active-case constraint per identity key or leaves that to the caller (Runtime Core).
- Whether `p_case_kind` is writable on update (gap if yes).
- Whether outcome is enforced as immutable after set.
- Whether `closed_at` is managed by the RPC or must be passed explicitly.

---

### 3.2 `rpc_get_contact_case_context_v1`

**Expected purpose**

Return all non-terminal active cases for a given clinic, contact, and conversation. Used by `getActiveCases` and `findActiveCase`.

**Expected input fields**

| Field | Required | Notes |
|---|---|---|
| `p_clinic_id` | Yes | Clinic-scoped |
| `p_contact_id` | Yes | |
| `p_conversation_id` | Yes | |
| `p_case_kind` | Optional | Used for `findActiveCase` filtering; may be client-side filter if RPC does not support it |
| `p_subject_kind` | Optional | Same as above |
| `p_subject_display_name` | Optional | Same as above |

**Expected output shape**

Returns one or more case records. Minimum expected columns per row: all Case identity, subject, operational, and lifecycle fields from Section 2 of `MINIMAL_CASE_STORE_CONTRACT.md`. Status column must be present to distinguish active from terminal cases.

**CaseRepository methods that depend on this RPC**

`getActiveCases`, `findActiveCase`

**Clinic-scoped?**

Must be. `p_clinic_id` must be required. Verification must confirm the RPC filters by clinic and does not return cases from other clinics.

**Supports multiple active cases per conversation?**

Critical. Must confirm that the RPC returns a set (multiple rows) rather than a single row. If it returns only the most recent single record, the adapter must normalize it — but this is only safe if the RPC returns the correct single case for the given identity key, not an arbitrary one. Verification must determine: does the RPC return all active cases or only the most recent?

**Supports subject identity?**

Must confirm that `subject_kind` and `subject_display_name` are present in the returned rows so that Runtime Core or adapter can distinguish Mikhail/self from Vasya/friend.

**Supports terminal outcome filtering?**

Must confirm that the RPC filters out closed/cancelled/expired/duplicate cases and returns only non-terminal cases. If it returns all cases, the adapter must filter.

**Mutates case_kind?**

Read-only RPC — must not mutate anything.

**Logs audit events?**

Read-only RPC — must not write audit events.

**Unknowns / gaps**

- Whether the RPC returns a result set (multiple rows) or a single row.
- Whether `p_case_kind`, `p_subject_kind`, and `p_subject_display_name` are supported as filter inputs or whether client-side filtering is required.
- Whether the returned rows include all necessary subject identity fields.
- Whether terminal cases are excluded automatically or must be filtered by adapter.
- Whether the RPC signature includes `p_clinic_id` as a required argument or whether it is optional/absent (gap if absent).

---

### 3.3 `rpc_log_case_event` (or equivalent event RPC)

**Expected purpose**

Append one immutable audit event to a case's event log. Used by `appendCaseEvent` for all significant lifecycle transitions and agent actions.

**Expected input fields**

| Field | Required | Notes |
|---|---|---|
| `p_clinic_id` | Yes | Clinic-scoped |
| `p_case_id` | Yes | Case the event belongs to |
| `p_event_kind` | Yes | Event type (e.g., `case_opened`, `case_updated`, `handoff_proposed`, `case_kind_changed`) |
| `p_actor` | Yes | Who performed the action: `patient_agent`, `runtime_core`, `operator` |
| `p_timestamp` | Yes | Event timestamp (may default to `now()` in DB) |
| `p_payload` | Optional | Structured JSON payload for event-specific data |

**Expected output shape**

Confirmation that the event was written. May return the persisted event record or a success indicator.

**CaseRepository methods that depend on this RPC**

`appendCaseEvent`

**Clinic-scoped?**

Must be, via `p_case_id` (which is tied to a specific clinic via the case record) or directly via `p_clinic_id`. Verification must confirm.

**Supports multiple active cases?**

Events are appended per `case_id`, so multi-case support follows from case identity. Verification must confirm there is no constraint that prevents multiple event streams per conversation.

**Supports subject identity?**

Events are per-case, not per-subject directly. Subject identity is on the case record. No additional requirement here.

**Supports terminal outcome?**

Events may record terminal transitions (e.g., `case_closed`, `outcome_set`). Must confirm `p_event_kind` accepts these values.

**Mutates case_kind?**

Must NOT mutate case_kind. Must confirm this RPC only appends events and has no side effects on case fields.

**Logs audit events?**

This RPC is itself the audit logging path. Confirm it produces an immutable append-only record.

**Unknowns / gaps**

- Whether the function name is exactly `rpc_log_case_event` or a different name. If the function does not exist under this name, an equivalent must be identified.
- Whether `p_actor` is supported or whether the field is named differently.
- Whether `p_payload` accepts arbitrary JSON or has a fixed schema.
- Whether the event log is truly append-only (no update/delete path on event rows).
- Whether `p_clinic_id` is a direct input or derived from `p_case_id` internally.

---

### 3.4 `rpc_prepare_admin_notification` (for `handoff.create` context)

**Expected purpose**

Persist a notification intent after a handoff case is closed with `outcome: handed_off`. Runtime Core calls this to record that a notification should be delivered. n8n/transport adapter reads and delivers. Runtime Core does not deliver directly.

**Expected input fields**

| Field | Required | Notes |
|---|---|---|
| `p_clinic_id` | Yes | Clinic-scoped |
| `p_case_id` | Yes | Case that triggered the notification |
| `p_notification_kind` | Yes | e.g., `admin_handoff` |
| `p_payload` | Optional | Structured notification data (patient name, reason, urgency) |

**Expected output shape**

Confirmation that the notification intent was recorded. May return a notification record ID.

**CaseRepository methods that depend on this RPC**

Not a `CaseRepository` method. Belongs to `NotificationRepository.prepareAdminNotification`. Included here because `handoff.create` depends on both CaseRepository and NotificationRepository.

**Clinic-scoped?**

Must be.

**Supports multiple active cases?**

Notifications are per-case, not per-conversation. No special multi-case requirement beyond correct `p_case_id` scoping.

**Mutates case_kind?**

Must NOT mutate case_kind.

**Logs audit events?**

Must confirm whether this RPC auto-logs a notification event or whether `appendCaseEvent` must be called separately after notification intent is recorded.

**Unknowns / gaps**

- Whether dedupe behavior is built into the RPC (prevents duplicate notifications for the same case).
- Whether notification routing configuration is stored in DB or must be passed as input.
- Whether any delivery side effect is triggered inside the RPC (gap if yes — delivery must remain in n8n/transport adapter).

---

## 4. Verification Checklist

For each candidate RPC, the following must be confirmed against the live DB before implementation begins.

### 4.1 `rpc_apply_case_decision_v1`

- [ ] Function exists in live DB under this exact name
- [ ] Function accepts `p_clinic_id` as a required argument
- [ ] Function accepts `p_case_kind` — and confirms whether `p_case_kind` is writable on update (must be absent or ignored on update)
- [ ] Function accepts `p_subject_kind` and `p_subject_display_name`
- [ ] Function accepts `p_outcome` and sets `closed_at` on terminal transition
- [ ] Function enforces outcome immutability after set
- [ ] Response includes all Case record fields needed by `CaseRepository`
- [ ] Role/permission grants are in place for the runtime service role
- [ ] No blocking unique constraint prevents multiple active cases per conversation when subjects differ
- [ ] No semantic routing hidden inside the SQL (e.g., auto-triggers, notification dispatchers) that contradicts `RUNTIME_SIDE_EFFECTS.md`

### 4.2 `rpc_get_contact_case_context_v1`

- [ ] Function exists in live DB under this exact name
- [ ] Function accepts `p_clinic_id` as a required argument
- [ ] Function returns a result set (multiple rows) or a single row (document which)
- [ ] Response includes `case_id`, `case_kind`, `subject_kind`, `subject_display_name`, `status`, `outcome` columns
- [ ] Response excludes terminal cases (or adapter must filter — document which)
- [ ] Role/permission grants are in place
- [ ] `p_case_kind` filtering is supported, or client-side filtering is confirmed as sufficient
- [ ] `p_subject_kind` / `p_subject_display_name` filtering is supported, or client-side filtering is confirmed as sufficient

### 4.3 `rpc_log_case_event` (or equivalent)

- [ ] Function exists in live DB — confirm exact name
- [ ] Function accepts `p_case_id` and `p_event_kind`
- [ ] Function accepts `p_actor` field
- [ ] Function accepts `p_payload` as JSON
- [ ] Event rows are append-only (no update/delete path on event table)
- [ ] Role/permission grants are in place
- [ ] Confirm whether `p_clinic_id` is required or derived from case

### 4.4 `rpc_prepare_admin_notification`

- [ ] Function exists in live DB under this exact name
- [ ] Function accepts `p_clinic_id` and `p_case_id`
- [ ] Function records notification intent only — no delivery side effect inside RPC
- [ ] Dedupe behavior is documented
- [ ] Role/permission grants are in place

---

## 5. Required Manual Evidence

Verification is not complete until concrete evidence is produced for each RPC candidate. Evidence must be committed to a verification note or shared with the owner before implementation begins.

For each candidate, produce:

1. **SQL function signature** — the exact `CREATE OR REPLACE FUNCTION` header from the live DB, showing argument names, types, and return type.

2. **Sample RPC call** — a minimal Supabase client or `psql` call demonstrating a successful invocation with realistic arguments.

3. **Sample returned payload** — the actual JSON or row data returned from a live call or test environment call.

4. **Missing fields or mismatch notes** — any field present in the contract but absent from the actual RPC, or any field present in the RPC but undocumented.

5. **Verdict** — one of:
   - `usable` — RPC matches the contract and can be called directly by `CaseRepository`.
   - `usable with adapter normalization` — RPC exists and is correct but requires an adapter layer to reshape inputs or outputs before use.
   - `not usable` — RPC does not exist, has an incompatible contract, or has side effects that violate architectural constraints. A new RPC or schema change is required.

---

## 6. CaseRepository Dependency Map

| CaseRepository method | Candidate RPC | Dependency type | Verification required before implementation |
|---|---|---|---|
| `openCase` | `rpc_apply_case_decision_v1` | Write | ✅ Required |
| `mergeCaseState` | `rpc_apply_case_decision_v1` | Write | ✅ Required — confirm `case_kind` is not patchable |
| `appendCaseEvent` | `rpc_log_case_event` (or equivalent) | Write | ✅ Required — confirm exact name and signature |
| `getActiveCases` | `rpc_get_contact_case_context_v1` | Read | ✅ Required — confirm multi-row result and clinic scoping |
| `findActiveCase` | `rpc_get_contact_case_context_v1` (filtered) | Read | ✅ Required — confirm filtering by `case_kind` + subject, or confirm client-side filter is safe |
| `closeCase` | `rpc_apply_case_decision_v1` | Write | ✅ Required — confirm terminal outcome and `closed_at` behavior |
| `prepareAdminNotification` (NotificationRepository) | `rpc_prepare_admin_notification` | Write | ✅ Required before `handoff.create` implementation |

---

## 7. Decision Gates

Implementation of `CaseRepository` or `handoff.create` is blocked until all gates below are passed.

### Gate 1 — All required RPC candidates confirmed

- `rpc_apply_case_decision_v1`: verdict produced and documented.
- `rpc_get_contact_case_context_v1`: verdict produced and documented.
- `rpc_log_case_event` (or equivalent): function name confirmed and verdict produced.
- `rpc_prepare_admin_notification`: verdict produced and documented (required for `handoff.create`).

### Gate 2 — Gaps documented

Any RPC candidate that returns verdict `not usable` must have a documented gap including:
- What is missing or incompatible.
- What the proposed resolution is (new RPC, schema extension, adapter-only workaround).

### Gate 3 — Owner approval for any new RPC or schema change

If a gap requires a new RPC function or a schema change, the owner must explicitly approve the change before any SQL is written. No schema change may be introduced based on this document alone.

### Gate 4 — Evidence committed

Concrete evidence (SQL signatures, sample calls, sample payloads, verdict) must be available and shared with the owner before the first line of `CaseRepository` implementation is written.

---

## 8. Non-Goals

This document does not define or authorize:

- SQL migrations.
- New RPC function implementations.
- `CaseRepository` TypeScript implementation.
- `handoff.create` executor implementation.
- `NotificationRepository` implementation.
- Admin notification delivery (remains in n8n/transport adapter).
- CRM integration or `booking.apply`.
- Booking-related RPC verification (separate scope).
- Case expiration or abandonment jobs.
- Deployment or migration steps.

---

## 9. Acceptance

After reading this document, a developer must be able to answer:

**What RPCs must be verified before writing CaseRepository?**
`rpc_apply_case_decision_v1`, `rpc_get_contact_case_context_v1`, and the case event logging RPC (exact name to confirm). `rpc_prepare_admin_notification` is required before `handoff.create`.

**What does verification require?**
Checking the live DB for: function existence, exact signature, required arguments including `p_clinic_id`, return shape, role permissions, and absence of forbidden side effects. Evidence must include SQL signature, sample call, sample payload, and a written verdict.

**What are the possible verdicts?**
`usable`, `usable with adapter normalization`, or `not usable`. A `not usable` verdict requires a documented gap and owner approval before any new RPC or schema change is introduced.

**What blocks implementation from starting?**
All three gates: all candidates confirmed, gaps documented, owner approval for any new RPC or schema change. No `CaseRepository` method may be implemented against an unverified candidate.

**What is not covered here?**
SQL migrations, new RPC implementations, runtime code, booking verification, case expiration, and deployment steps. Those are separate scopes.
