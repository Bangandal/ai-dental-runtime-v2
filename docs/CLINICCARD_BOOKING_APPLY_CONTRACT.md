# ClinicCard booking.apply Contract

**Status: CONTRACT ONLY — no implementation exists yet.**

This document defines the production contract for `booking.apply` — the only runtime-approved operation that may create a real appointment/visit in ClinicCard. No write code, no tool wiring, and no ClinicCard API calls are added by this document.

---

## 1. Purpose

`booking.apply` is the **only** runtime-approved operation that may create a real appointment or visit in ClinicCard.

The assistant **may only tell the patient that the booking/request is created after `booking.apply` returns explicit proof from ClinicCard.** Any patient-facing confirmation phrase before that proof is a contract violation (see §5).

This contract governs the future implementation. Until `booking.apply` is implemented and enabled, the runtime remains read-only and must not use booking confirmation language.

---

## 2. Required inputs

### Patient text inputs

Collected through conversation. Missing any → `validation_error`, ask patient.

| Field | Type | Notes |
|---|---|---|
| `first_name` | string | Patient first name |
| `last_name` | string | Patient last name |
| `service` / `reason` | string | Service type or reason for visit |
| `requested_date` | ISO YYYY-MM-DD | Must be in the future |
| `requested_time` | HH:mm | Slot start time |

### Runtime/contact fields (resolved before write)

These are **not patient text inputs**. They are resolved by the runtime before `booking.apply` runs the createPatient/createVisit sequence. Missing any → `needs_more_info` or `config_missing` (see §6).

| Field | Source |
|---|---|
| `phone_number` | Channel-native capture or manual fallback (see below) |
| `phone_source` | How phone was obtained (see below) |
| `phone_consent` | True when patient explicitly shared via contact button; implicit for adapter-provided numbers |
| `duration_minutes` | Config / service_to_duration rule — never from patient |
| `doctor_id` | Config / service_to_doctor rule — never from patient |
| `cabinet_id` | Config — never from patient |
| `timezone` | Clinic config |

### Phone capture policy

`phone_number` is required before `createPatient`/`createVisit`. The clinic needs a reliable contact channel for appointment confirmation, changes, and patient identification. Phone must be collected through channel-native mechanisms when available.

**Telegram:**
- Use `KeyboardButton` with `request_contact=true`.
- The patient must explicitly tap the contact sharing button — phone is not provided automatically.
- Store: `phone_number`, `phone_source="telegram_contact_button"`, `phone_consent=true`, `phone_collected_at`.

**WhatsApp:**
- The adapter may provide sender/contact phone from WhatsApp message metadata.
- If available, use as `phone_source="whatsapp_sender"`. No explicit consent button needed; the send act is implicit proof.
- If not available, fall through to manual input.
- Exact WhatsApp payload handling is adapter-specific and must be verified before implementation.

**Manual fallback** (any channel, if native contact sharing is unavailable or refused):
- Ask the patient to type their phone number.
- Store as `phone_source="manual_input"`.
- Validate format before write.

**Existing ClinicCard patient:**
- If a matching patient is found in ClinicCard and already has a usable phone on record, the runtime may use it as `phone_source="existing_cliniccard_patient"` without asking the patient again.

---

## 3. Clinic config requirements

`booking.apply` must resolve all of the following from trusted server-side config before any ClinicCard write. If required config is missing, abort immediately — do not create patient, do not create visit.

| Config key | Required | Notes |
|---|---|---|
| `CLINICCARD_BOOKING_MODE` | Yes | Must be `live` — any other value disables booking.apply entirely |
| `CLINICCARD_API_BASE_URL` | Yes | Base URL for ClinicCard REST API |
| `CLINICCARD_API_TOKEN` | Yes | Auth token |
| `CLINICCARD_DEFAULT_DOCTOR_ID` | Yes | Fallback doctor if not overridden by service rule |
| `CLINICCARD_DEFAULT_CABINET_ID` | Yes | Fallback cabinet if not overridden by service rule |
| `clinic.timezone` | Yes | Used for date/time resolution |
| `clinic.default_appointment_duration_minutes` | Yes | Used when service rule is absent |
| `clinic.working_hours` | Yes | Used for availability sanity check |
| `clinic.service_to_duration_rules` | No | Override duration per service |
| `clinic.service_to_doctor_rules` | No | Override doctor per service |

`CLINICCARD_BOOKING_MODE=live` is the master gate. If this key is absent or set to any value other than `live` (e.g. `disabled`, `dry_run`), `booking.apply` must return `booking_write_disabled` immediately without making any ClinicCard API calls (see §6).

If any required config is missing:
- Return `config_missing` (see §6).
- Do **not** say "clinic staff will help with scheduling" unless a handoff or admin notification side effect was actually created/queued.
- Patient reply: "The system cannot complete your booking request right now. Please contact the clinic directly."

---

## 4. Booking sequence

Steps must run in this exact order. No skipping, no reordering.

```
A. Validate patient text inputs
   └── All required fields present (first_name, last_name, service, date, time)? → continue
   └── Any missing? → return validation_error, ask patient

B. Resolve config and mode gate
   └── CLINICCARD_BOOKING_MODE must equal "live" → else return booking_write_disabled
   └── doctor_id / cabinet_id / duration_minutes / timezone from config (never from patient)
   └── Apply service_to_duration / service_to_doctor rules if available
   └── Config missing required key? → return config_missing

B2. Resolve phone
   └── Try channel-native: Telegram contact button / WhatsApp sender metadata
   └── Try existing ClinicCard patient match
   └── Fallback: ask patient to type phone manually
   └── phone_number still missing? → return needs_more_info, required_field="phone"
       (if channel=Telegram: response must request contact via native contact button)
   └── Do not proceed to createPatient/createVisit without phone_number

C. Search/create patient in ClinicCard
   └── Search by first_name + last_name + phone
   └── Patient found with phone → use existing cliniccard_patient_id, set phone_source="existing_cliniccard_patient"
   └── Patient not found → createPatient (phone_number required)
   └── createPatient fails → return patient_create_failed (no visit created)

D. Re-read ClinicCard visits immediately before createVisit
   └── GET visits for the resolved doctor_id AND cabinet_id on requested_date
   └── This is a fresh read — do NOT use stale availability.check result

E. Conflict check (deterministic)
   slotStart = requested_time
   slotEnd   = requested_time + duration_minutes
   For each existing visit V:
     timeOverlap = slotStart < V.time_end AND slotEnd > V.time_start
     conflict = timeOverlap AND (V.doctor_id == resolved_doctor_id OR V.cabinet_id == resolved_cabinet_id)
   └── Conflict found? → return availability_conflict, propose alternatives

F. No conflict → createVisit
   └── POST createVisit to ClinicCard with status PLANNED
   └── Store returned visit_id as proof
   └── createVisit API error → return visit_create_failed (created_visit: false)

G. Only after createVisit success:
   └── Store proof (visit_id, patient_id, source, operation, created_at)
   └── Link proof to case meta/collected
   └── Allow patient-facing reply that booking/request was created (see §5)
```

---

## 5. Status language

### Forbidden before ClinicCard createVisit success

The following words and phrases are **prohibited** in patient-facing replies before `booking.apply` returns explicit proof:

| Forbidden |
|---|
| booked |
| confirmed |
| записано |
| запись создана |
| запись подтверждена |
| мы вас записали |

**Allowed** while collecting inputs or before proof:
- "Могу проверить время"
- "Подберу доступное время"
- "Сейчас проверю возможность записи"
- "Пока не подтверждаю запись"

### Allowed after createVisit success

Phrasing depends on the ClinicCard visit status returned:

| ClinicCard status | Allowed patient phrase |
|---|---|
| `PLANNED` | "Запись создана" / "Заявка на запись создана" |
| `PLANNED` | "Время забронировано в системе клиники" |
| `CONFIRMED` | "Запись подтверждена" (only if ClinicCard status is CONFIRMED) |

Do **not** say "confirmed" for a `PLANNED` visit unless clinic policy explicitly maps PLANNED to confirmed.

---

## 6. booking.apply output contract

### Success

```json
{
  "ok": true,
  "status": "planned",
  "cliniccard_visit_id": "<visit id from ClinicCard>",
  "cliniccard_patient_id": "<patient id from ClinicCard>",
  "date": "YYYY-MM-DD",
  "time_start": "HH:mm",
  "time_end": "HH:mm",
  "doctor_id": "<resolved doctor id>",
  "cabinet_id": "<resolved cabinet id>",
  "proof": {
    "source": "cliniccard",
    "operation": "createVisit",
    "created_at": "<ISO timestamp>"
  }
}
```

`status` reflects the ClinicCard visit status (`planned` or `confirmed`). The runtime must not upgrade `planned` to `confirmed` on its own.

### Failure

Every failure response must include `created_visit: false` and `may_claim_booked: false` at the top level.

```json
{
  "ok": false,
  "created_visit": false,
  "may_claim_booked": false,
  "error": {
    "code": "<code>",
    "message": "<human-readable detail>",
    "required_field": "<field name, if code=needs_more_info>"
  }
}
```

| Error code | Meaning |
|---|---|
| `booking_write_disabled` | `CLINICCARD_BOOKING_MODE` is not `live` — write operations are disabled |
| `validation_error` | One or more required patient text fields are missing |
| `config_missing` | A required server-side config key (other than BOOKING_MODE) is absent |
| `needs_more_info` | A required contact field is missing (e.g. phone); `required_field` names it |
| `patient_create_failed` | ClinicCard rejected createPatient; no visit was attempted |
| `availability_conflict` | Slot is taken after re-read; propose alternatives |
| `cliniccard_unavailable` | ClinicCard API is unreachable or returned a 5xx error |
| `visit_create_failed` | ClinicCard rejected createVisit after patient was found/created |

`created_visit: false` and `may_claim_booked: false` are **mandatory** on every failure code.

---

## 7. Runtime invariants

The implementation must enforce all of the following:

1. **Deterministic action, not model decision.** `booking.apply` is a controlled runtime operation with explicit pre/post checks. The model proposes inputs; the runtime executes and validates.

2. **Re-read immediately before createVisit.** The availability.check result from an earlier turn is stale. A fresh visit read must happen within the same booking.apply call, immediately before createVisit.

3. **Never trust stale availability.check as booking proof.** availability.check = informational read. booking.apply = authoritative write with re-verification.

4. **Idempotent on duplicate Telegram updates.** Use `trace_id` / `update_id` / `message_id` / `conversation_id` to detect and reject duplicate booking attempts. A duplicate must return the original proof, not create a second visit.

5. **Audit event for every attempt.** Write an audit record for: attempted, succeeded, failed — regardless of outcome.

6. **Link proof to case.** On success, store `cliniccard_visit_id` and full `proof` object in case `meta` / `collected`.

7. **Preserve Case ≠ Appointment invariant.** A ClinicCard visit is not the same as a case. The case lifecycle (open, closed, etc.) is governed separately and is not closed by this contract unless separately defined.

---

## 8. Case state rules

### Before successful createVisit

- Case `outcome` must **not** be `booked`
- Case `status` must **not** be closed as booked
- `booking_request` or `booking_intake` are valid interim case outcomes

### After successful createVisit

- `cliniccard_visit_id` and proof may be stored in case `collected`/`meta`
- Case `outcome` may become `booked` or `planned` — **only if** `cliniccard_visit_id` proof exists
- Case may remain open or be closed according to later policy; closing behaviour is **not** defined by this contract

---

## 9. Admin and handoff boundaries

`booking.apply` must **not** call `handoff.create` or `admin.notify` unless those tools are separately implemented and approved.

If `booking.apply` fails for a reason that requires human intervention:
- Return the failure code and reason.
- Do **not** tell the patient "an administrator has been notified" or "clinic staff will contact you" unless a notification or handoff side effect was actually created and queued.

---

## 10. Test plan (for future implementation)

These tests must pass before `booking.apply` may ship to production.

| # | Test | Expected |
|---|---|---|
| 1 | Missing required patient text field (e.g. `last_name`) | `validation_error`, `may_claim_booked: false` |
| 2 | Required config key absent | `config_missing`, no patient created, no visit created |
| 3 | `CLINICCARD_BOOKING_MODE` absent or not `live` | `booking_write_disabled`, no API call made |
| 4 | Slot conflicts after fresh re-read | `availability_conflict`, no visit created, propose alternatives |
| 5 | Booking succeeds only after createVisit proof | `ok: true`, `cliniccard_visit_id` present in result |
| 6 | Duplicate Telegram update replayed | Returns original proof, no second visit created |
| 7 | ClinicCard status PLANNED | Patient reply says "создана", not "подтверждена" |
| 8 | ClinicCard API unavailable | `cliniccard_unavailable`, `may_claim_booked: false` |
| 9 | ClinicCard rejects createPatient | `patient_create_failed`, no visit attempted |
| 10 | createPatient succeeds but createVisit rejected | `visit_create_failed`, `created_visit: false` |
| 11 | Phone missing, channel=Telegram | `needs_more_info`, `required_field="phone"`, response requests contact button |
| 12 | Telegram contact button payload received | `phone_source="telegram_contact_button"`, `phone_consent=true` stored |
| 13 | Native contact sharing unavailable or refused | Manual phone input requested, `phone_source="manual_input"` on success |
| 14 | WhatsApp adapter provides sender phone | Phone requirement satisfied, `phone_source="whatsapp_sender"` |
| 15 | Phone missing (any channel) | `needs_more_info`, no createPatient/createVisit attempted |

---

## Non-goals of this contract

The following are explicitly **out of scope** for this PR:

- `createPatient` implementation
- `createVisit` implementation
- Runtime tool wiring for `booking.apply`
- `slot_hold` / `booking.confirm` / `cancel_hold`
- `handoff.create` / `admin.notify`
- SQL migrations
- Telegram adapter changes
- Any runtime behavioural change
