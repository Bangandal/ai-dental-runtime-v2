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
| `outcome` | Not present | Store in `meta` or `collected` jsonb for MVP |
| `conversation_id` | Not present | Store in `meta` or `collected` jsonb for MVP; see Section 6 |

These gaps are handled by the adapter layer. No schema migration is required or authorized for MVP.

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
- Store `subject_kind`, `subject_display_name`, `outcome`, and `conversation_id` in `collected` or `meta` jsonb.

---

### `mergeCaseState`

**Candidate RPC:** `core.rpc_apply_case_decision_v1` with `reuse_case` action.

**Adapter responsibility:**
- Map logical mutable fields to physical columns and jsonb bags.
- Must preserve existing `case_type`. See Section 5 (Critical Risk) for the default mutation risk.

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
- Deserialize `subject_kind`, `subject_display_name`, `outcome`, and `conversation_id` from `collected` / `meta` jsonb.

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

**Candidate RPC:** `core.rpc_apply_case_decision_v1` with `reuse_case` action and `case_status` set to `closed` or `handoff`.

**Adapter responsibility:**
- Write `outcome` to `meta` or `collected` jsonb for MVP.
- Confirm `closed_at` is managed by the RPC or must be passed explicitly.
- Must preserve existing `case_type` (same risk as `mergeCaseState` — see Section 5).

---

## 5. Required Adapter Normalization

The physical DB schema is not one-to-one compatible with the Minimal Case Store Contract. The adapter layer must handle all translation.

| Logical field | Physical mapping | Direction | Notes |
|---|---|---|---|
| `case_kind` | `case_type` | Bidirectional | Adapter maps on every read and write |
| `subject_kind` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `subject_display_name` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `subject_relation` | `collected` or `meta` jsonb | Bidirectional | No physical column |
| `outcome` | `meta` or `collected` jsonb | Bidirectional | No physical column for MVP |
| `conversation_id` | `meta` or `collected` jsonb | Bidirectional | No physical column; see Section 6 |
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

`rpc_prepare_admin_notification` is usable for `admin.notify` intent recording after a handoff case is closed with `outcome: handed_off`. n8n or the transport adapter then reads pending notification records and delivers them. Runtime Core does not deliver directly.

**handoff.create dependency:** `handoff.create` must define when `need_admin` and `current_case_id` are set before `rpc_prepare_admin_notification` can be called. The notification RPCs are ready, but the call site logic is deferred to the `handoff.create` implementation scope.

---

## 10. Verdict

| RPC candidate | Verdict | Key constraint |
|---|---|---|
| `core.rpc_apply_case_decision_v1` | **Usable with adapter normalization** | Risk: `p_case_type` defaults to `'intake'` on `reuse_case`. Adapter must always pass explicit `case_type`. Confirm `case_kind` immutability behavior before implementation. |
| `core.rpc_open_case_v1` | **Usable for open only** | Explicit open path. Confirm signature and preferred path vs `rpc_apply_case_decision_v1(open_case)` before implementation. |
| `core.rpc_get_contact_case_context_v1` | **Usable with adapter filtering** | Gap: no `conversation_id` argument. Adapter must filter `open_cases` array by `conversation_id` stored in `collected`/`meta`. |
| `core.rpc_log_case_event` | **Usable** | Confirm `event_kind`, `actor`, and `payload` field names against live signature before implementation. |
| `core.rpc_link_runtime_artifacts_to_case_v1` | **Usable** | For linking `conversation_id` and booking artifacts to a case. Confirm input shape before use. |
| `core.rpc_prepare_admin_notification` | **Usable — deferred to handoff.create scope** | Ready for `admin.notify` integration. Requires `handoff.create` to define `need_admin` / `current_case_id` call site before this RPC is invoked. |

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
Every read and write path. `case_kind` ↔ `case_type`. `subject_kind`, `subject_display_name`, `outcome`, `conversation_id` ↔ `collected`/`meta` jsonb. `open_cases` JSON array ↔ typed `Case[]`.

**Which DB fields are missing from the logical contract?**
`case_kind` (physical: `case_type`), `subject_kind`, `subject_display_name`, `outcome`, and `conversation_id` are not first-class columns. They are handled via jsonb for MVP.

**Why must `reuse_case` preserve `case_type`?**
`rpc_apply_case_decision_v1` defaults `p_case_type` to `'intake'`. Calling `reuse_case` without passing the existing `case_type` explicitly will silently overwrite the case's type and violate `case_kind` immutability.

**Why must implementation of `handoff.create` not start until this mapping is accepted?**
`handoff.create` depends on `closeCase`, `appendCaseEvent`, and `rpc_prepare_admin_notification`. The adapter normalization for `closeCase` (including `outcome` in jsonb and `case_type` preservation) and the call-site definition for `rpc_prepare_admin_notification` (`need_admin`, `current_case_id`) must be confirmed and accepted before `handoff.create` implementation begins. Starting without this creates risk of silent case reclassification and incorrect notification state.
