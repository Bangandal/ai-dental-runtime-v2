# ClinicCard booking.apply Contract

**Status: CONTRACT ONLY — no implementation exists yet.**

This document defines the production contract for `booking.apply` — the only runtime-approved operation that may create a real appointment/visit in ClinicCard. No write code, no tool wiring, and no ClinicCard API calls are added by this document.

---

## 1. Purpose

`booking.apply` is the **only** runtime-approved operation that may create a real appointment or visit in ClinicCard.

The assistant **may only tell the patient that the booking/request is created after `booking.apply` returns explicit proof from ClinicCard.** Any patient-facing confirmation phrase before that proof is a contract violation (see §5).

This contract governs the future implementation. Until `booking.apply` is implemented and enabled, the runtime remains read-only and must not use booking confirmation language.

---

## 2. Required patient inputs

The following fields must all be present before `booking.apply` may run. Missing any field → return `validation_error`, ask patient for the missing information.

| Field | Type | Notes |
|---|---|---|
| `first_name` | string | Patient first name |
| `last_name` | string | Patient last name |
| `service` / `reason` | string | Service type or reason for visit |
| `requested_date` | ISO YYYY-MM-DD | Must be in the future |
| `requested_time` | HH:mm | Slot start time |
| `duration_minutes` | integer | From config/service rules |
| `doctor_id` | string | From trusted config only — never from patient text |
| `cabinet_id` | string | From trusted config only — never from patient text |

### Phone number policy

- **Do not require phone for MVP Telegram flow** unless ClinicCard rejects patient creation without it.
- If ClinicCard's actual API requires phone to create a patient, `booking.apply` must return `needs_more_info` with `required_field: "phone"`.
- **Do not collect phone preemptively** in a messenger channel before this proof of requirement exists.

---

## 3. Clinic config requirements

`booking.apply` must resolve all of the following from trusted server-side config before any ClinicCard write. If required config is missing, abort immediately — do not create patient, do not create visit.

| Config key | Required | Notes |
|---|---|---|
| `CLINICCARD_API_BASE_URL` | Yes | Base URL for ClinicCard REST API |
| `CLINICCARD_API_TOKEN` | Yes | Auth token |
| `CLINICCARD_DEFAULT_DOCTOR_ID` | Yes | Fallback doctor if not overridden |
| `CLINICCARD_DEFAULT_CABINET_ID` | Yes | Fallback cabinet if not overridden |
| `clinic.timezone` | Yes | Used for date/time resolution |
| `clinic.default_appointment_duration_minutes` | Yes | Used when service rule is absent |
| `clinic.working_hours` | Yes | Used for availability sanity check |
| `clinic.service_to_duration_rules` | No | Override duration per service |
| `clinic.service_to_doctor_rules` | No | Override doctor per service |

If any required config is missing:
- Return `config_missing` (see §6).
- Do **not** say "clinic staff will help with scheduling" unless a handoff or admin notification side effect was actually created/queued.
- Patient reply: "The system cannot complete your booking request right now. Please contact the clinic directly."

---

## 4. Booking sequence

Steps must run in this exact order. No skipping, no reordering.

```
A. Validate collected inputs
   └── All required fields present? → continue
   └── Any missing? → return validation_error, ask patient

B. Resolve config
   └── doctor_id / cabinet_id / duration_minutes / timezone from config
   └── Apply service_to_duration / service_to_doctor rules if available
   └── Config missing required key? → return config_missing

C. Search/create patient in ClinicCard
   └── Search by first_name + last_name (+ phone if available)
   └── Patient found → use existing cliniccard_patient_id
   └── Patient not found → createPatient
   └── createPatient fails → return patient_create_failed (no visit created)

D. Re-read ClinicCard visits immediately before createVisit
   └── GET visits for the resolved doctor_id on requested_date
   └── This is a fresh read — do NOT use stale availability.check result

E. Conflict check (deterministic)
   slotStart = requested_time
   slotEnd   = requested_time + duration_minutes
   For each existing visit V:
     conflict = slotStart < V.time_end AND slotEnd > V.time_start
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
| `validation_error` | One or more required patient input fields are missing |
| `config_missing` | A required server-side config key is absent |
| `needs_more_info` | ClinicCard requires an additional field (e.g. phone); `required_field` names it |
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
| 1 | Missing required field (e.g. `last_name`) | `validation_error`, `may_claim_booked: false` |
| 2 | Required config key absent | `config_missing`, no patient created, no visit created |
| 3 | Slot conflicts after fresh re-read | `availability_conflict`, no visit created, propose alternatives |
| 4 | Booking succeeds only after createVisit proof | `ok: true`, `cliniccard_visit_id` present in result |
| 5 | Duplicate Telegram update replayed | Returns original proof, no second visit created |
| 6 | ClinicCard status PLANNED | Patient reply says "создана", not "подтверждена" |
| 7 | ClinicCard API unavailable | `cliniccard_unavailable`, `may_claim_booked: false` |
| 8 | ClinicCard rejects createPatient | `patient_create_failed`, no visit attempted |
| 9 | Phone not pre-collected unless required | No phone prompt until ClinicCard returns phone requirement |
| 10 | createPatient succeeds but createVisit rejected | `visit_create_failed`, `created_visit: false` |

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
