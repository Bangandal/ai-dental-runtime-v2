# RPC Candidate Verification Report — Minimal Case Store

## 1. Purpose

This report documents how the existing Supabase/Core case schema maps to the Minimal Case Store Contract before implementing `CaseRepository` or `handoff.create`.

It defines:
- The physical DB model and its divergence from the logical contract.
- The existing RPC candidates and their roles.
- The mapping from each `CaseRepository` method to an RPC candidate.
- Required adapter normalization.
- Risks that must be understood before implementation starts.
- A per-RPC verdict.

No schema changes, new RPC functions, or implementation code are defined here.

---

## 2. Existing Physical DB Model

### 2.1 Case Store Tables

The current core DB includes the following tables relevant to case persistence:

| Table | Role |
|---|---|
| `core.cases` | Primary case records |
| `core.case_events` | Append-only case audit log |
| `core.notifications` | Admin notification records |
| `core.convo_state` | Conversation-level runtime state |

### 2.2 `core.cases` — Current Column Set

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Physical case identifier |
| `clinic_id` | — | Clinic scope. Present. |
| `contact_id` | — | Contact who initiated the case. Present. |
| `case_number` | — | Human-readable case number. |
| `case_type` | — | Physical type field. Maps to logical `case_kind` via adapter. See Section 4. |
| `topic` | — | Free-text topic. |
| `status` | — | Lifecycle status. |
| `priority` | — | Priority level. |
| `source_channel` | — | Inbound channel (Telegram, WhatsApp, etc.). |
| `summary` | — | Free-text summary. |
| `collected` | `jsonb` | Structured collected data bag. Used for fields not in the physical schema. |
| `meta` | `jsonb` | Additional metadata bag. Used for fields not in the physical schema. |
| `opened_at` | timestamp | When the case was opened. |
| `last_activity_at` | timestamp | Last activity timestamp. |
| `handoff_at` | timestamp | When the handoff was initiated. |
| `admin_notified_at` | timestamp | When admin was notified. |
| `resolved_at` | timestamp | When the case was resolved. |
| `closed_at` | timestamp | When the case was closed. |
| `close_reason` | — | Why the case was closed. |

### 2.3 Fields Not Present in Physical Schema (Logical Contract Gap)

The following fields are defined in the Minimal Case Store Contract but do **not** exist as first-class columns in the current `core.cases` schema:

| Logical field | Physical status | MVP handling |
|---|---|---|
| `case_kind` | Not present — maps to physical `case_type` | Adapter maps `case_kind` ↔ `case_type` |
| `subject_kind` | Not present | Store in `collected` or `meta` jsonb |
| `subject_display_name` | Not present | Store in `collected` or `meta` jsonb |
| `subject_relation` | Not present | Store in `collected` or `meta` jsonb |
| `service_interest` | Not present as first-class column | Store in `collected` or `meta` jsonb |
| `preferred_date` | Not present | Store in `collected` or `meta` jsonb |
| `preferred_time` | Not present | Store in `collected` or `meta` jsonb |
| `urgency` | Not present as first-class column | Store in `collected` or `meta` jsonb |
| `handoff_reason` | Not present | Store in `collected` or `meta` jsonb |
| `notes` | Partially covered by `summary` | Store additional notes in `collected` or `meta` jsonb; `summary` may be used for free-text |
| `outcome` | Not present | Store in `meta` or `collected` jsonb for MVP |
| `conversation_id` | Not present | Store in `meta` or `collected` jsonb for MVP; see Section 6 |

All fields from the Minimal Case Store Contract that are not first-class columns are handled by the adapter layer via `collected`/`meta` jsonb. No schema migration is required or authorized for MVP.

---

## 3. Existing RPC Candidates

The following core RPC functions exist and are candidates for `CaseRepository` and `handoff.create` implementation.

| RPC function | Category | Expected role |
|---|---|---|
| `core.rpc_apply_case_decision_v1` | Case write | Open case, merge case state, close case |
| `core.rpc_open_case_v1` | Case write | Explicit open-case path |
| `core.rpc_get_contact_case_context_v1` | Case read | Return active cases for a clinic/contact |
| `core.rpc_log_case_event` | Audit | Append case event |
| `core.rpc_link_runtime_artifacts_to_case_v1` | Case write | Link runtime artifacts (conversation, booking) to case |
| `core.rpc_prepare_admin_notification` | Notification | Prepare pending Telegram admin notification record |
| `core.rpc_log_notification` | Notification | Log a notification delivery attempt |
| `core.rpc_mark_notification_sent` | Notification | Mark notification as delivered |
| `core.rpc_mark_notification_failed` | Notification | Mark notification as failed |

---

## 4. Mapping — CaseRepository to RPC Candidates

### `openCase`

**Candidate RPCs:** `core.rpc_apply_case_decision_v1` (with `open_case` action) or `core.rpc_open_case_v1`

Both candidates support opening a new case. `rpc_open_case_v1` is the more explicit path for open-only semantics. Confirm which is preferred for initial open before implementation.

**Adapter responsibility:**
- Map logical `case_kind` → physical `case_type`.
- Store all logical fields absent from the physical schema in `collected` or `meta` jsonb: `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes` (if beyond `summary`), `outcome`, `conversation_id`.

---

### `mergeCaseState`

**Candidate RPC:** `core.rpc_apply_case_decision_v1` with `reuse_case` action.

**Adapter responsibility:**
- Map logical mutable fields to physical columns and jsonb bags: `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes` all go to `collected`/`meta`.
- Must preserve existing `case_type`. See Section 6 (Critical Risk) for the default mutation risk.

---

### `appendCaseEvent`

**Candidate RPC:** `core.rpc_log_case_event`

No normalization gap expected. Confirm `event_kind`, `actor`, and `payload` field names against live function signature before implementation.

---

### `getActiveCases`

**Candidate RPC:** `core.rpc_get_contact_case_context_v1`

Called with `clinic_id` + `contact_id`. Returns `open_cases` as a JSON array of active case records.

**Adapter responsibility:**
- Normalize `open_cases` JSON array → `Case[]`.
- Map physical `case_type` → logical `case_kind`.
- Deserialize all jsonb-stored fields from `collected`/`meta`: `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `outcome`, `conversation_id`.

See Section 6 for the conversation scope gap.

---

### `findActiveCase`

**Candidate:** Client-side filter over the `open_cases` JSON array returned by `rpc_get_contact_case_context_v1`.

The RPC does not support direct filtering by `case_kind`, subject identity, or `conversation_id`. The adapter must:
1. Call `getActiveCases(clinic_id, contact_id, conversation_id)`.
2. Filter the result array by logical `case_kind` (mapped from `case_type`), `subject_kind`, `subject_display_name`, and `conversation_id` (read from `collected`/`meta`).
3. Return the first match or `null`.

See Section 7 for multi-case filtering detail.

---

### `closeCase`

**Candidate RPC:** `core.rpc_apply_case_decision_v1` with `reuse_case` action and `case_status` set to `closed`.

For `closeCase(..., outcome: handed_off)`:
- The terminal `case_status` must be `closed`, not `handoff`.
- `handoff` may represent an intermediate lifecycle state only if it is explicitly modeled in a future contract; it must not be used as a terminal close status.
- A case closed with `outcome: handed_off` must not appear in subsequent `getActiveCases` reads. Setting `case_status` to `closed` ensures this.
- `outcome: handed_off` is stored in `meta` or `collected` jsonb for MVP.
- `closed_at` must be set by the RPC or confirmed and handled explicitly by the adapter. Confirm against live function signature before implementation.

**Adapter responsibility:**
- Write `outcome` to `meta` or `collected` jsonb for MVP.
- Confirm `closed_at` is set on every terminal call (RPC-managed or adapter-set).
- Must preserve existing `case_type` (same risk as `mergeCaseState` — see Section 6).

---

## 5. Required Adapter Normalization

The physical DB schema is not one-to-one compatible with the Minimal Case Store Contract. The adapter layer must handle all translation.

| Logical field | Physical mapping | Direction | Notes |
|---|---|---|---|
| `case_kind` | `case_type` | Bidirectional | Adapter maps on every read and write |
| `subject_kind` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `subject_display_name` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `subject_relation` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `service_interest` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `preferred_date` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `preferred_time` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `urgency` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `handoff_reason` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `notes` | `collected`/`meta` jsonb (supplementing `summary`) | Bidirectional | Physical `summary` column may serve free-text; additional structured notes go to jsonb |
| `outcome` | `meta` or `collected` jsonb | Bidirectional | No physical column for MVP |
| `conversation_id` | `meta` or `collected` jsonb | Bidirectional | No physical column; see Section 7 |
| `Case[]` | `open_cases` JSON array | Read | Adapter normalizes JSON array to typed `Case[]` |

The adapter must be the only place this translation occurs. `CaseRepository` methods expose the logical contract. Callers must not handle physical field names.

---

## 6. Critical Risk — `case_type` Default Mutation

`core.rpc_apply_case_decision_v1` has `p_case_type` with a default value of `'intake'`.

**Risk:** If `reuse_case` is called without explicitly passing the correct `p_case_type`, the existing case's `case_type` will be silently overwritten with `'intake'`.

This violates the `case_kind` immutability rule from the Minimal Case Store Contract (Section 4). A `booking_intake` case could become `intake`; a `reschedule` or `cancel` case could be silently reclassified.

**Required behavior:** `CaseRepository` must never call `reuse_case` without reading the existing `case_type` from the current case record and passing it back explicitly in `p_case_type`. The adapter must preserve `case_type` on every merge call.

This must be confirmed against the live function signature before `mergeCaseState` or `closeCase` are implemented.

---

## 7. Conversation Scope Gap

`core.rpc_get_contact_case_context_v1` is scoped by `clinic_id` and `contact_id` only. It does not accept `conversation_id` as an input argument.

**Implication:** A contact with active cases across multiple conversations will return all their open cases from a single `getActiveCases` call. Adapter filtering by `conversation_id` is required to scope results to the current conversation.

**MVP approach:**
- Use `clinic_id` + `contact_id` as the read scope when calling the RPC.
- Store `conversation_id` in `meta` or `collected` jsonb at case open time.
- Filter the returned `open_cases` array in the adapter by `conversation_id` read from `collected`/`meta`.

**Future consideration:** A first-class `conversation_id` column on `core.cases` would eliminate the adapter filter. This is a future schema migration decision for the owner; it is not part of MVP scope.

---

## 8. Multi-Case Support

`core.rpc_get_contact_case_context_v1` returns `open_cases` as a JSON array. Multiple active cases per contact are supported by the RPC.

`findActiveCase` must filter this array by the full identity key:

- `clinic_id` — confirmed from RPC scope
- `contact_id` — confirmed from RPC scope
- `case_kind` — matched against physical `case_type` via adapter mapping
- `subject_kind` — read from `collected`/`meta`
- `subject_display_name` — read from `collected`/`meta` when available
- `conversation_id` — read from `collected`/`meta` (see Section 7)

Example: a contact with both a `booking_intake` case for `self` (Mikhail) and a `booking_intake` case for `friend` (Vasya) will appear as two entries in `open_cases`. `findActiveCase` must use the full identity key to return the correct case and must not return both.

---

## 9. Admin Notification Foundation

The following RPCs support admin notification persistence:

| RPC | Role |
|---|---|
| `core.rpc_prepare_admin_notification` | Creates a notification record with status `pending`, a dedupe key, recipient from clinic settings, and `case_id` from `current_case_id` or lead case ID. |
| `core.rpc_log_notification` | Logs a notification delivery attempt. |
| `core.rpc_mark_notification_sent` | Marks a notification as successfully delivered. |
| `core.rpc_mark_notification_failed` | Marks a notification as failed. |

`rpc_prepare_admin_notification` supports two valid admin notification trigger paths:

### Trigger Path 1 — Admin Handoff

`handoff.create` closes a case with `outcome: handed_off` and calls `rpc_prepare_admin_notification` with the handoff `case_id` and `need_admin` context. n8n or the transport adapter reads pending notification records and delivers them. Runtime Core does not deliver directly.

### Trigger Path 2 — Urgent Escalation

When Runtime Core accepts an urgent case or receives an explicit urgency escalation, `rpc_prepare_admin_notification` must be called **immediately** — it must not wait for a subsequent `handoff.create` call. Urgent cases may require immediate admin attention before any handoff workflow completes. The notification intent must be prepared and set to `pending` as soon as urgency is accepted by Runtime Core.

### Call-Site Dependency

Both trigger paths require `handoff.create` or the urgency acceptance path to define:
- `current_case_id` — the case that triggered the notification
- `need_admin` — flag confirming notification intent is required
- notification kind — `admin_handoff` or `urgent_escalation` (or equivalent enum)

The notification RPCs are ready. The call-site logic for both paths is deferred to the `handoff.create` and urgency handling implementation scope.

---

## 10. Verdict

| RPC candidate | Verdict | Key constraint |
|---|---|---|
| `core.rpc_apply_case_decision_v1` | **Usable with adapter normalization** | Risk: `p_case_type` defaults to `'intake'` on `reuse_case`. Adapter must always pass explicit `case_type`. Confirm `case_kind` immutability behavior before implementation. |
| `core.rpc_open_case_v1` | **Usable for open only** | Explicit open path. Confirm signature and preferred path vs `rpc_apply_case_decision_v1(open_case)` before implementation. |
| `core.rpc_get_contact_case_context_v1` | **Usable with adapter filtering** | Gap: no `conversation_id` argument. Adapter must filter `open_cases` array by `conversation_id` stored in `collected`/`meta`. |
| `core.rpc_log_case_event` | **Usable** | Confirm `event_kind`, `actor`, and `payload` field names against live signature before implementation. |
| `core.rpc_link_runtime_artifacts_to_case_v1` | **Usable** | For linking `conversation_id` and booking artifacts to a case. Confirm input shape before use. |
| `core.rpc_prepare_admin_notification` | **Usable — deferred to handoff.create and urgency handling scope** | Supports two trigger paths: (1) admin handoff closure and (2) urgent case escalation. Must not be narrowed to handoff only. Urgent path must call this RPC immediately on urgency acceptance, without waiting for `handoff.create`. Requires integration with `current_case_id`, notification intent kind, and `need_admin` semantics before either call site is implemented. |

---

## 11. Non-Goals

This document does not define or authorize:

- SQL migrations or schema changes.
- New RPC function implementations.
- `CaseRepository` TypeScript implementation.
- `handoff.create` executor implementation.
- Admin notification delivery (remains in n8n/transport adapter).
- CRM adapter or `booking.apply`.
- Booking-related RPC verification (separate scope).
- Case expiration or abandonment jobs.
- Deployment or migration steps.

---

## 12. Acceptance

After reading this report, a developer must be able to answer:

**Which existing RPCs can be used for CaseRepository?**
All six `CaseRepository` methods can be mapped to existing RPCs without new functions. `openCase` → `rpc_apply_case_decision_v1` or `rpc_open_case_v1`. `mergeCaseState` and `closeCase` → `rpc_apply_case_decision_v1(reuse_case)`. `appendCaseEvent` → `rpc_log_case_event`. `getActiveCases` and `findActiveCase` → `rpc_get_contact_case_context_v1` with adapter filtering.

**Where is adapter normalization required?**
Every read and write path. `case_kind` ↔ `case_type`. All Minimal Case Store subject, operational, and outcome fields not present as physical columns — `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `outcome`, `conversation_id` — are read and written via `collected`/`meta` jsonb. `open_cases` JSON array ↔ typed `Case[]`.

**Which DB fields are missing from the logical contract?**
`case_kind` (physical: `case_type`), `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `outcome`, and `conversation_id` are not first-class columns. All are handled via `collected`/`meta` jsonb for MVP.

**What is the correct terminal status for a handed-off case?**
`closed`. `case_status` must be set to `closed`, not `handoff`, when `closeCase` is called with `outcome: handed_off`. A case in `handoff` status is not terminal and will still appear in active-case reads. Only `closed` guarantees the case is excluded from `getActiveCases` results.

**Why must `reuse_case` preserve `case_type`?**
`rpc_apply_case_decision_v1` defaults `p_case_type` to `'intake'`. Calling `reuse_case` without passing the existing `case_type` explicitly will silently overwrite the case's type and violate `case_kind` immutability.

**What are the two admin notification trigger paths?**
(1) Admin handoff: `handoff.create` closes a case with `outcome: handed_off` and prepares a notification. (2) Urgent escalation: Runtime Core accepts urgency and must call `rpc_prepare_admin_notification` immediately, without waiting for a handoff flow. Both paths require `current_case_id` and `need_admin` to be defined at the call site.

**Why must implementation of `handoff.create` not start until this mapping is accepted?**
`handoff.create` depends on `closeCase`, `appendCaseEvent`, and `rpc_prepare_admin_notification`. The adapter normalization for `closeCase` (terminal `closed` status, `outcome` in jsonb, `case_type` preservation, `closed_at` behavior) and the call-site definitions for both notification trigger paths must be confirmed and accepted before implementation begins. Starting without this creates risk of silent case reclassification, handed-off cases remaining active, and incorrect notification state.
