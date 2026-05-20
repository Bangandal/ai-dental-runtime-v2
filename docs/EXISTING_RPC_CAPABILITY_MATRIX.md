# Existing RPC Capability Matrix

## Purpose and boundary

This matrix documents how Runtime V2 capabilities map to the **existing** Supabase/Core RPC and DB layer.

- Existing RPC/DB is the operational source of truth.
- Runtime V2 must not duplicate transactional booking logic in TypeScript.
- Executors should call repository adapters.
- Repository adapters should call existing RPC where suitable.
- If an RPC output shape is imperfect, adapter normalization is required.
- If an RPC lacks required data, mark as a gap.
- If an RPC mixes read/write behavior, mark as review needed.
- Do not rewrite existing RPC functions until audited and tested.

## 1) Contact / Case Context

**Runtime needs**
- identify or create contact
- load active/recent case context
- load active booking context

**Candidate existing RPC**
- `rpc_get_or_create_contact`
- `rpc_get_contact_case_context_v1`
- `rpc_get_active_booking_context_v1`

**Runtime repository**
- `ContactRepository.getOrCreateContact`
- `ContactRepository.getContactCaseContext`
- `ContactRepository.getActiveBookingContext`

**Status**
- likely reusable
- adapter normalization required

**Risks / gaps**
- confirm exact output shape contracts
- confirm `patient_subject` support (or mark explicit gap)

## 2) Case State / Case Events

**Runtime needs**
- merge/update case state
- append case events
- preserve case history

**Candidate existing RPC**
- `rpc_apply_case_decision_v1`
- `rpc_log_case_event` (or equivalent event RPC if present)

**Runtime repository**
- `CaseRepository.mergeCaseState`
- `CaseRepository.appendCaseEvent`

**Status**
- likely reusable with review

**Risks / gaps**
- confirm no semantic routing hidden in SQL
- confirm state merge contract matches Runtime V2 expectations

## 3) Booking / Holds / Appointment Transactions

**Runtime needs**
- `availability.check`
- `hold.create`
- `booking.confirm`
- `cancel_hold`

**Candidate existing RPC**
- `rpc_apply_booking_decision_v1`

**Runtime repository**
- `BookingRepository.checkAvailability`
- `BookingRepository.createHold`
- `BookingRepository.confirmBooking`
- `BookingRepository.cancelHold`

**Status**
- likely reusable for transactional booking operations after adapter review

**Critical rule**
Runtime must not duplicate transactional booking logic, including:
- working hours validation
- slot conflict checks
- hold creation transaction
- appointment creation transaction
- hold cancellation transaction

**Risks / gaps**
- `availability.check` may require read-only behavior.
- If `rpc_apply_booking_decision_v1(propose_slot)` creates a hold, it may be unsuitable for pure `availability.check`.
- A dedicated read-only availability RPC may be needed.
- confirm output shape for hold and appointment records
- confirm `should_notify_admin` / event output behavior

## 4) Appointment Lookup / Post-booking Context

**Runtime needs**
- answer “what time are we booked?”
- answer “when is my appointment?”
- support post-booking turn context
- support future reschedule/cancel context

**Candidate existing RPC**
- unknown / to be audited
- possibly `rpc_get_active_booking_context_v1` if it returns latest/upcoming appointment

**Runtime repository**
- `BookingRepository.lookupAppointment`

**Status**
- gap / review needed

**Risks / gaps**
- may require new RPC or extension
- must support contact + case + patient_subject-aware lookup

## 5) Knowledge / FAQ Retrieval

**Runtime needs**
- `kb.search`

**Candidate existing RPC**
- `kb.rpc_retrieve_context_json`
- kb chunks retrieval function if present

**Runtime repository**
- `KnowledgeRepository.searchKnowledge`

**Status**
- likely reusable

**Risks / gaps**
- confirm chunk shape
- confirm scores/document metadata
- confirm clinic scoping

## 6) Admin Notification Preparation

**Runtime needs**
- prepare notification payload after backend event
- do not deliver from runtime

**Candidate existing RPC**
- `rpc_prepare_admin_notification`
- `rpc_log_notification`

**Runtime repository**
- `NotificationRepository.prepareAdminNotification`

**Status**
- likely reusable

**Critical rule**
- n8n or an adapter delivers notifications.
- Runtime and repositories prepare/log only.
- `admin.notify` remains side effect, not a runtime tool.

**Risks / gaps**
- confirm dedupe behavior
- confirm notification routing configuration
- confirm no delivery side effect in repository path

## 7) Message Batching / Inbound Buffer

**Runtime needs**
- not part of current executor flow
- future inbound gateway batching support

**Candidate existing RPC**
- `rpc_append_inbound_message_batch`
- `rpc_lock_ready_inbound_batches`
- `rpc_mark_batch_flushed` (or equivalent)

**Status**
- existing separate transport/inbound layer
- not Runtime Tool executor concern

**Critical rule**
- batching belongs before runtime turn
- do not put batching inside Planner/Policy

## 8) Debug / Replay

**Runtime needs**
- future persistence of `RuntimeDebugEnvelope`
- future replay tools

**Candidate existing tables/RPC**
- debug JSONL currently external
- maybe events/log tables
- unknown for full envelope persistence

**Status**
- future gap

**Risks / gaps**
- do not persist debug envelope in this PR
- future RPC/table may be needed

## Decision table

| Runtime capability | Runtime repository method | Candidate RPC | Current status | Adapter needed | Runtime must not duplicate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Contact identity upsert | `ContactRepository.getOrCreateContact` | `rpc_get_or_create_contact` | likely_reusable | yes | Contact canonicalization / identity rules in DB layer | Confirm output payload shape |
| Contact case context | `ContactRepository.getContactCaseContext` | `rpc_get_contact_case_context_v1` | likely_reusable | yes | Case context assembly logic in SQL/RPC layer | Validate `patient_subject` support |
| Active booking context | `ContactRepository.getActiveBookingContext` | `rpc_get_active_booking_context_v1` | likely_reusable | yes | Booking context derivation in RPC layer | Confirm upcoming/latest semantics |
| Case state merge | `CaseRepository.mergeCaseState` | `rpc_apply_case_decision_v1` | review_needed | yes | Case-state merge behavior in backend transaction | Validate contract and semantic-safety |
| Case event append | `CaseRepository.appendCaseEvent` | `rpc_log_case_event` (or equivalent) | review_needed | yes | Event write path and ordering guarantees | Confirm event schema + side effects |
| Availability read | `BookingRepository.checkAvailability` | `rpc_apply_booking_decision_v1` (tentative) | review_needed | yes | Slot rules and conflict checks in backend | availability.check may require read-only RPC |
| Hold creation | `BookingRepository.createHold` | `rpc_apply_booking_decision_v1` | likely_reusable | yes | Hold transaction logic in backend | Confirm hold output shape |
| Booking confirm | `BookingRepository.confirmBooking` | `rpc_apply_booking_decision_v1` | likely_reusable | yes | Appointment transaction logic in backend | Confirm appointment + event/admin flags |
| Hold cancellation | `BookingRepository.cancelHold` | `rpc_apply_booking_decision_v1` | likely_reusable | yes | Hold cancellation transaction logic in backend | Confirm cancellation status shape |
| Appointment lookup | `BookingRepository.lookupAppointment` | unknown / maybe `rpc_get_active_booking_context_v1` | gap | yes | Post-booking lookup semantics | Likely RPC extension/new RPC needed |
| Knowledge retrieval | `KnowledgeRepository.searchKnowledge` | `kb.rpc_retrieve_context_json` | likely_reusable | yes | Retrieval ranking/selection in existing KB layer | Verify metadata, scores, clinic scoping |
| Admin notification prep | `NotificationRepository.prepareAdminNotification` | `rpc_prepare_admin_notification` | likely_reusable | yes | Runtime must not send notifications directly | admin.notify remains side effect |
| Message batching | N/A for runtime tools | `rpc_append_inbound_message_batch`, `rpc_lock_ready_inbound_batches`, `rpc_mark_batch_flushed` | not_runtime_concern | no | Planner/Policy must not handle batching | Belongs to inbound gateway stage |
| Debug envelope persistence | future debug repository (TBD) | unknown | gap | yes | No debug persistence in this PR | Future RPC/table decision required |

## Executor implementation rule

Before implementing any real executor:

1. Identify candidate RPC.
2. Confirm exact input contract.
3. Confirm exact output contract.
4. Confirm side effects.
5. Confirm transaction boundaries.
6. Decide one path:
   - reuse as-is
   - wrap with adapter normalization
   - patch RPC
   - add new RPC
7. Only then implement executor.
