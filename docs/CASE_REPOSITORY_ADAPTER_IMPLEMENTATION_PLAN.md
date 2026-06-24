# CaseRepository Adapter Implementation Plan

## 1. Purpose

`CaseRepository` is the adapter between the logical runtime case contract (defined in `MINIMAL_CASE_STORE_CONTRACT.md`) and the existing Supabase/Core RPC and physical schema (documented in `RPC_CANDIDATE_VERIFICATION_REPORT.md`).

Its role:
- Expose the logical `Case` type and `CaseRepository` interface to Runtime Core executors.
- Translate all logical fields to physical DB columns, jsonb bags, and RPC arguments.
- Translate all RPC responses back to typed `Case` objects.
- Enforce safety rules: `case_type` preservation, `case_kind` immutability, terminal status correctness, and jsonb field integrity.

Runtime Core executors must call `CaseRepository` methods only. They must not call Supabase RPC directly.

No schema changes, new RPCs, or runtime code are implemented in this document.

---

## 2. Repository / File Discovery Checklist

Before writing any implementation code, a developer must inspect the actual repository structure and locate the following. **Do not invent or assume file paths — verify against the live repo.**

- [ ] Supabase client initialization — locate existing client setup (likely in `src/` or `lib/` or a dedicated `supabase/` directory). Confirm the client is a singleton or how it is imported.
- [ ] Existing repository pattern files — check whether `ContactRepository`, `KnowledgeRepository`, or other repositories exist. Use their structure as reference for `CaseRepository`.
- [ ] Type definitions for existing `Case`-related types — locate any existing `case_type`, `CaseKind`, `CaseStatus`, or `CaseOutcome` enums or types.
- [ ] `rpc_apply_case_decision_v1` call sites — grep for any existing calls to this RPC to understand current argument shape and response handling.
- [ ] `rpc_get_contact_case_context_v1` call sites — grep for existing uses of this RPC.
- [ ] `open_cases` jsonb handling — grep for existing parsing of `open_cases` JSON array.
- [ ] `collected` / `meta` jsonb read/write patterns — grep for existing jsonb access to understand field naming conventions in use.
- [ ] Unit and integration test directory — locate test files before writing new ones.

All file paths in implementation PRs must be verified against the discovered structure, not assumed from this document.

---

## 3. CaseRepository Interface

```typescript
interface CaseRepository {
  getActiveCases(
    clinic_id: string,
    contact_id: string,
    conversation_id: string
  ): Promise<Case[]>

  findActiveCase(input: FindActiveCaseInput): Promise<Case | null>

  openCase(input: OpenCaseInput): Promise<Case>

  appendCaseEvent(input: AppendCaseEventInput): Promise<void>

  mergeCaseState(input: MergeCaseStateInput): Promise<Case>

  closeCase(input: CloseCaseInput): Promise<Case>
}
```

Supporting input types (to be defined in implementation):

```typescript
interface FindActiveCaseInput {
  clinic_id: string
  contact_id: string
  conversation_id: string
  case_kind: CaseKind
  subject_kind: SubjectKind
  subject_display_name?: string
}

interface OpenCaseInput {
  clinic_id: string
  contact_id: string
  conversation_id: string
  case_kind: CaseKind
  subject_kind: SubjectKind
  subject_display_name?: string
  subject_relation?: string
  service_interest?: string
  preferred_date?: string
  preferred_time?: string
  urgency?: boolean
  notes?: string
}

interface CaseStatePatch {
  subject_kind?: SubjectKind
  subject_display_name?: string
  subject_relation?: string
  service_interest?: string
  preferred_date?: string
  preferred_time?: string
  urgency?: boolean
  handoff_reason?: string
  notes?: string
  status?: CaseStatus
  // case_kind is NOT included — see Section 7
}

interface AppendCaseEventInput {
  case_id: string
  clinic_id: string
  event_kind: string
  actor: 'patient_agent' | 'runtime_core' | 'operator'
  payload?: Record<string, unknown>
}

interface MergeCaseStateInput {
  clinic_id: string
  contact_id: string
  conversation_id: string
  case_id: string
  patch: CaseStatePatch
}

interface CloseCaseInput {
  clinic_id: string
  contact_id: string
  conversation_id: string
  case_id: string
  outcome: CaseOutcome
  metadata?: CaseCloseMetadata
}

interface CaseCloseMetadata {
  handoff_reason?: string
  notes?: string
}
```

---

## 4. Implementation Order

Implement in this exact order. Do not skip ahead.

### Step 1 — `getActiveCases`

Read-only. No write risk. Foundation for all subsequent methods.

### Step 2 — `findActiveCase`

Client-side filter over `getActiveCases`. No additional RPC calls. Depends on Step 1.

### Step 3 — `openCase`

First write path. Depends on `getActiveCases` for duplicate-prevention check before opening.

### Step 4 — `appendCaseEvent`

Simplest write path. No merge logic. Can be verified independently.

### Step 5 — `mergeCaseState`

Write path with `case_type` preservation risk. Must not be implemented until `openCase` is confirmed working and the preservation behavior is verified against the live RPC.

### Step 6 — `closeCase`

Terminal write path. Must not be implemented until `mergeCaseState` is confirmed, the `closed` terminal status behavior is verified, and `closed_at` handling is confirmed.

### Step 7 — `handoff.create` (separate PR)

Must not start until Steps 1–6 are implemented, tested, and accepted. Depends on `closeCase` with `outcome: handed_off` and `rpc_prepare_admin_notification` call site definition.

---

## 5. RPC Mapping

| CaseRepository method | RPC candidate | Action / mode |
|---|---|---|
| `getActiveCases` | `core.rpc_get_contact_case_context_v1` | Read — returns `open_cases` JSON array |
| `findActiveCase` | Client-side filter over `getActiveCases` result | No direct RPC call |
| `openCase` | `core.rpc_apply_case_decision_v1` (`open_case`) or `core.rpc_open_case_v1` | See decision note below |
| `appendCaseEvent` | `core.rpc_log_case_event` | Write — append-only |
| `mergeCaseState` | (1) `getActiveCases` / `findActiveCase` to load existing case → (2) `core.rpc_apply_case_decision_v1` (`reuse_case`) with explicit `case_type` | Write — merge mutable fields; requires existing case lookup |
| `closeCase` | (1) `getActiveCases` / `findActiveCase` to load existing case → (2) `core.rpc_apply_case_decision_v1` (`reuse_case`, `case_status = closed`) with explicit `case_type` | Write — terminal; requires existing case lookup |

**`openCase` RPC decision:** Before implementing `openCase`, confirm with the owner whether `rpc_apply_case_decision_v1(open_case)` or `rpc_open_case_v1` is the preferred path. `rpc_open_case_v1` is explicit open-only; `rpc_apply_case_decision_v1(open_case)` follows the unified decision API. Do not assume — verify against the live schema signature and choose one path.

---

## 6. Adapter Normalization

All translation between logical contract fields and physical DB fields must occur inside `CaseRepository`. Callers must see only logical types.

### 6.1 Field Mapping — Write Path (logical → physical)

| Logical field | Physical target | Notes |
|---|---|---|
| `case_kind` | `case_type` (physical column) | Adapter maps enum values. Must never be passed on `reuse_case` without reading existing value first. |
| `subject_kind` | `collected` or `meta` jsonb | Key: `subject_kind` |
| `subject_display_name` | `collected` or `meta` jsonb | Key: `subject_display_name` |
| `subject_relation` | `collected` or `meta` jsonb | Key: `subject_relation` |
| `service_interest` | `collected` or `meta` jsonb | Key: `service_interest` |
| `preferred_date` | `collected` or `meta` jsonb | Key: `preferred_date` |
| `preferred_time` | `collected` or `meta` jsonb | Key: `preferred_time` |
| `urgency` | `collected` or `meta` jsonb | Key: `urgency` |
| `handoff_reason` | `collected` or `meta` jsonb | Key: `handoff_reason` |
| `notes` | `collected` or `meta` jsonb (supplementing `summary`) | Key: `notes`. Physical `summary` may serve free-text; structured notes go to jsonb. |
| `outcome` | `collected` or `meta` jsonb | Key: `outcome`. No physical column for MVP. |
| `conversation_id` | `collected` or `meta` jsonb | Key: `conversation_id`. No physical column; see Section 7 (conversation scope gap). |

**jsonb merge rule:** On every write, the adapter must merge new values into existing `collected`/`meta` jsonb, not overwrite the entire object. Existing keys not included in the patch must be preserved.

### 6.2 Field Mapping — Read Path (physical → logical)

| Physical source | Logical field | Notes |
|---|---|---|
| `row.case_id ?? row.id` | `case_id` | Use `case_id` column if present; fall back to `id`. If neither is present, the row is invalid — fail loudly, do not return a `Case` without a `case_id`. |
| `case_type` | `case_kind` | Reverse enum mapping |
| `status` | `status` | Direct |
| `opened_at` | `created_at` | Rename |
| `last_activity_at` | `updated_at` | Rename |
| `closed_at` | `closed_at` | Direct |
| `collected['subject_kind'] ?? meta['subject_kind']` | `subject_kind` | Read `collected` first, fall back to `meta` |
| `collected['subject_display_name'] ?? meta['subject_display_name']` | `subject_display_name` | Read `collected` first, fall back to `meta` |
| `collected['subject_relation'] ?? meta['subject_relation']` | `subject_relation` | Read `collected` first, fall back to `meta` |
| `collected['service_interest'] ?? meta['service_interest']` | `service_interest` | Read `collected` first, fall back to `meta` |
| `collected['preferred_date'] ?? meta['preferred_date']` | `preferred_date` | Read `collected` first, fall back to `meta` |
| `collected['preferred_time'] ?? meta['preferred_time']` | `preferred_time` | Read `collected` first, fall back to `meta` |
| `collected['urgency'] ?? meta['urgency']` | `urgency` | Read `collected` first, fall back to `meta` |
| `collected['handoff_reason'] ?? meta['handoff_reason']` | `handoff_reason` | Read `collected` first, fall back to `meta` |
| `collected['notes'] ?? meta['notes']` | `notes` | Read `collected` first, fall back to `meta` |
| `collected['outcome'] ?? meta['outcome']` | `outcome` | Read `collected` first, fall back to `meta` |
| `collected['conversation_id'] ?? meta['conversation_id']` | `conversation_id` | Read `collected` first, fall back to `meta` |

**Canonical jsonb bag for operational fields:** `collected` is the canonical write target for all operational and subject fields. `meta` is the fallback read source for compatibility with records written before this convention was established. New writes go to `collected`.

### 6.3 `open_cases` JSON Array → `Case[]`

`rpc_get_contact_case_context_v1` returns `open_cases` as a JSON array. The adapter must:
1. Parse the JSON array.
2. For each element, resolve `case_id` as `row.case_id ?? row.id`. If neither exists, reject the row with a loud error — do not silently return a `Case` without a `case_id`.
3. Apply the full read-path mapping (Section 6.2) to each valid element.
4. Return a typed `Case[]`.

If the RPC returns a single row instead of a result set, the adapter must detect and normalize accordingly. Confirm the actual return shape against the live schema before implementation.

---

## 7. Critical Safety Rules

These rules must be enforced by the `CaseRepository` implementation. Any deviation is a defect.

### Rule 1 — Never call `reuse_case` without preserving existing `case_type`

`rpc_apply_case_decision_v1` defaults `p_case_type` to `'intake'`. Both `mergeCaseState` and `closeCase` receive `clinic_id`, `contact_id`, `conversation_id`, and `case_id` in their input to support this lookup.

On every `reuse_case` call, the adapter must execute this sequence:
1. Call `getActiveCases(clinic_id, contact_id, conversation_id)` to load the current case set, or call `findActiveCase` with the known identity key.
2. Locate the existing case by `case_id` in the returned array.
3. Extract `case_type` from the located case record.
4. Pass the extracted `case_type` explicitly as `p_case_type` in the `reuse_case` call.
5. If the existing case cannot be located, fail loudly — do not proceed with a default or inferred `case_type`.

Never pass a default or inferred value. Never omit `p_case_type` on `reuse_case`. If no scoped read path can locate the case, that is a programming error, not a recoverable state.

### Rule 2 — Never mutate `case_kind` silently

`case_kind` is immutable after open. `CaseStatePatch` does not include `case_kind`. The adapter must not accept or pass `case_kind` on any `mergeCaseState` call.

If a `case_kind` change is needed, the caller must use explicit reclassification (open new case or audited reclassification). `CaseRepository` must not enable silent reclassification.

### Rule 3 — `closeCase(outcome: handed_off)` must use `case_status = closed`

`handoff` is not a terminal case status. A case with `case_status = handoff` remains active and will appear in `getActiveCases` reads.

For `closeCase` with any outcome including `handed_off`, `cancelled_by_patient`, `booked`, `answered`, `failed`, `abandoned`, or `duplicate`: the adapter must set `case_status = closed` (or `cancelled` / `expired` as appropriate). `outcome` is stored in `collected`/`meta` jsonb for MVP.

### Rule 4 — `outcome: booked` is rejected in CaseRepository MVP

`outcome: booked` is not a supported outcome for `CaseRepository.closeCase` in MVP. `BookingRepository` and `booking.apply` do not yet exist. There is no typed confirmation payload or booking result gate that `closeCase` can validate against.

`CaseRepository.closeCase` must explicitly reject `outcome: booked` at the adapter boundary — it must not pass this outcome to any RPC. The rejection must be a loud error, not a silent no-op.

When `BookingRepository` and `booking.apply` are implemented in a future PR, they will introduce a typed `booking_result` confirmation payload. Only at that point may `outcome: booked` be accepted by `closeCase`, and only after a confirmed `booking.apply` success is passed as part of the input. That integration is deferred and out of scope for this plan.

### Rule 5 — `getActiveCases` is clinic/contact scoped; adapter filters by `conversation_id`

`rpc_get_contact_case_context_v1` does not accept `conversation_id`. The adapter must:
1. Call the RPC with `clinic_id` + `contact_id`.
2. Filter the returned `open_cases` array to include only cases where `collected['conversation_id']` or `meta['conversation_id']` matches the requested `conversation_id`.

### Rule 6 — `findActiveCase` must distinguish subject identity

Two active cases for the same `contact_id`, `conversation_id`, and `case_kind` but different subjects (`self` vs `friend`) are distinct and must not collide. `findActiveCase` must filter by the full identity key: `case_kind`, `subject_kind`, and `subject_display_name` (when provided).

### Rule 7 — jsonb merge must not drop existing fields

On every write that includes a `collected`/`meta` patch, the adapter must merge into the existing object, not overwrite it. Existing keys not in the current patch must survive the write.

---

## 8. Tests to Implement in Later Code PRs

The following tests must be written when `CaseRepository` is implemented. They are defined here so that the implementation PR can be written with these test contracts in mind.

| Test | What it verifies |
|---|---|
| `getActiveCases normalizes open_cases JSON to Case[]` | Adapter correctly deserializes RPC response into typed `Case[]` with logical field names |
| `getActiveCases resolves case_id from row.case_id ?? row.id` | `case_id` is correctly extracted regardless of which column the RPC returns |
| `getActiveCases rejects rows missing both case_id and id` | Invalid rows fail loudly, not silently |
| `getActiveCases filters by conversation_id` | Only cases matching `conversation_id` in `collected`/`meta` are returned |
| `getActiveCases reads jsonb fields from collected first, meta as fallback` | All jsonb-backed fields are correctly deserialized from both bags |
| `findActiveCase returns null when no match` | No false positives on identity key mismatch |
| `findActiveCase filters by case_kind and subject_kind` | Distinct subjects for same `case_kind` are not confused |
| `findActiveCase does not conflate self and friend cases` | Mikhail/self and Vasya/friend return as separate cases or null correctly |
| `openCase stores all missing fields into collected/meta` | All jsonb-mapped fields are persisted at open time |
| `openCase does not open duplicate for same identity key` | `findActiveCase` check before open prevents duplicates |
| `mergeCaseState loads existing case and preserves case_type` | `reuse_case` call reads existing case via getActiveCases/findActiveCase and always passes explicit `case_type` |
| `mergeCaseState fails loudly if case_id not found in active cases` | Missing case is a hard error, not a silent default |
| `mergeCaseState preserves existing collected/meta fields` | jsonb merge does not drop keys not included in the patch |
| `closeCase loads existing case and preserves case_type` | Same as mergeCaseState — lookup required before reuse_case |
| `closeCase handed_off uses status closed` | Terminal status is `closed`, not `handoff`; outcome is in jsonb |
| `closeCase sets closed_at` | `closed_at` is present on the returned case record |
| `closeCase rejects outcome booked in MVP` | `outcome: booked` throws a hard error — no booking.apply confirmation mechanism exists |

---

## 9. Acceptance Criteria

After reading this plan, a developer must be able to implement `CaseRepository` without guessing:

**Which RPCs to call?**
`rpc_get_contact_case_context_v1` for reads. `rpc_apply_case_decision_v1` (with explicit `open_case` or `reuse_case` action) for writes. `rpc_log_case_event` for events. See Section 5 for full mapping.

**Which fields map to jsonb?**
All logical fields not present as first-class columns on `core.cases`: `subject_kind`, `subject_display_name`, `subject_relation`, `service_interest`, `preferred_date`, `preferred_time`, `urgency`, `handoff_reason`, `notes`, `outcome`, `conversation_id`. See Section 6 for exact keys.

**How is `case_type` preserved?**
`mergeCaseState` and `closeCase` both receive `clinic_id`, `contact_id`, `conversation_id`, and `case_id`. Before calling `reuse_case`, they call `getActiveCases` (or `findActiveCase`) with the scoped identifiers, locate the existing case by `case_id`, extract its `case_type`, and pass it explicitly as `p_case_type`. If the case cannot be found, the method fails loudly. It never omits `p_case_type` and never passes a default.

**How is `case_id` resolved from `open_cases`?**
`case_id = row.case_id ?? row.id`. If neither column is present, the row is invalid and the adapter must fail loudly — it must not silently return a `Case` without a `case_id`.

**How are jsonb fields read?**
Every jsonb-backed field uses `collected[field] ?? meta[field]`. `collected` is canonical for new writes. `meta` is the fallback for compatibility. No jsonb-backed field is read from `collected` only.

**How are active cases filtered?**
`rpc_get_contact_case_context_v1` is called with `clinic_id` + `contact_id`. The adapter filters the returned `open_cases` array by `conversation_id` from jsonb. `findActiveCase` additionally filters by `case_kind`, `subject_kind`, and `subject_display_name`.

**How does `closeCase` work?**
Call `rpc_apply_case_decision_v1(reuse_case)` with `case_status = closed`. Store `outcome` in `collected`/`meta`. Confirm `closed_at` is set. Never pass `handoff` as the terminal status. Reject `outcome: booked` with a hard error — `BookingRepository` does not exist in MVP.

**What is the MVP `booked` outcome status?**
`outcome: booked` is explicitly rejected by `CaseRepository.closeCase` in MVP. It will only be accepted after `BookingRepository` and `booking.apply` are implemented and a typed `booking_result` confirmation is passed as input.

**What tests are required?**
See Section 8 for the full list. Tests must be written in the same PR as the implementation or in an immediately following test PR.

**Why must `handoff.create` wait?**
`handoff.create` depends on `closeCase` working correctly with `outcome: handed_off` and terminal `closed` status, and on `rpc_prepare_admin_notification` call-site logic being defined. Both depend on `CaseRepository` being implemented and accepted first.

---

## 10. Rollback

Delete `docs/CASE_REPOSITORY_ADAPTER_IMPLEMENTATION_PLAN.md`.

---

## Next Suggested Step

After this plan is reviewed and merged: implement the read-path code PR — `getActiveCases` + `findActiveCase` only. No write paths in that PR.
