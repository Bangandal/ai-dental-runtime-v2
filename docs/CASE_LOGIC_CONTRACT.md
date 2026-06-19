# Case Logic Contract

## 1. Core Principle

A **Case** is an operational task.

- Case is not a chat.
- Case is not an appointment.
- Case tracks an operational thread of work that Runtime Core owns and persists.

An **Appointment** is a confirmed calendar/CRM object. An appointment can only be created by `booking.apply` after the backend/CRM adapter confirms success. A case that contains booking intent is not an appointment. A handoff is not an appointment. A note is not an appointment.

---

## 2. Ownership

**Runtime Core owns:**

- Case identity (case ID, clinic ID, contact ID, subject).
- Case state (status, outcome, transitions, timestamps).
- Case audit records and persistence.
- Validation of all proposed case updates.

**Patient Agent may:**

- Propose case creation or update through `case.upsert`.
- Propose adding a note through `case.add_note`.
- Propose a handoff through `handoff.create`.

**Runtime validates and persists approved updates.** A Patient Agent proposal is only a proposal until Runtime Core validates it against contact identity, current case state, allowed transitions, and policy gates. Runtime Core persists approved changes. Runtime Core rejects invalid proposals.

---

## 3. Case Kinds for MVP

| Kind | Description | Status |
|---|---|---|
| `booking_intake` | Patient expresses intent to book an appointment. | Limited until CRM adapter exists |
| `reschedule` | Patient requests to move an existing appointment. | Limited until CRM adapter exists |
| `cancel` | Patient requests to cancel an existing appointment. | Limited until CRM adapter exists |
| `admin_handoff` | Patient requests human/admin attention or the runtime determines handoff is required. | Active |
| `process_status` | Patient inquires about the status of a prior request, case, or booking. | Active |
| `urgent` | Patient expresses urgency or a clinical emergency requiring immediate attention. | Active |

**Limited** means `case.upsert` and `case.add_note` can operate, `handoff.create` can operate, but `booking.apply` must remain disabled or return `not_configured` until the CRM adapter exists. No case of kind `booking_intake`, `reschedule`, or `cancel` may produce outcome `booked` without a confirmed backend booking result.

---

## 4. Case Opening Rules

### Open a Case When

Runtime Core should open a case when the conversation contains one of the following operational intents:

- **Booking intent** — patient wants to book an appointment.
- **Reschedule intent** — patient wants to move an existing appointment.
- **Cancel intent** — patient wants to cancel an existing appointment.
- **Process status inquiry** — patient is asking about the status of a prior request or case.
- **Admin/human request** — patient explicitly asks to speak to a person or have someone call back.
- **Urgent request** — patient expresses urgency or clinical emergency.

Examples that open a case:

- "Can I book a cleaning next Tuesday?"
- "I need to reschedule my Friday appointment."
- "Please cancel my visit."
- "Did anyone get back to me yet?"
- "I need to talk to someone."
- "My tooth is in serious pain, I need help today."

### Do Not Open a Case For

Runtime Core must not open a case for low-operational-value conversation with no action intent:

- **Greeting** — "Hi", "Hello", "Good morning."
- **Simple FAQ** — "What are your hours?", "Do you accept children?", "What is whitening?"
- **Casual clarification with no action intent** — vague follow-up with no request for action.

If a FAQ interaction evolves into a booking intent, reschedule, handoff request, or urgent request, Runtime Core should then open a case at that point.

---

## 5. Case Update Rules

A case may be updated when new operational facts appear in the conversation. Updates must be proposed by the Patient Agent through `case.upsert` or `case.add_note` and validated by Runtime Core before persistence.

**Updatable fields:**

- `subject` — the operational category of the case (e.g., changed from `process_status` to `booking_intake`).
- `patient_name` — patient's reported name.
- `service_interest` — type of service the patient is requesting (cleaning, implant, whitening, etc.).
- `preferred_date` — patient's stated preferred date.
- `preferred_time` — patient's stated preferred time.
- `relation_to_another_person` — whether the booking is for the patient themselves or for someone else.
- `notes` — additional operational notes relevant to the case.
- `urgency` — whether urgency has been declared or escalated.
- `handoff_reason` — the reason a handoff is proposed (admin request, unsupported service, urgent).

Runtime Core validates that proposed updates are consistent with current case state and allowed transitions before persisting.

---

## 6. Case Closing Rules

A case closes only when a **terminal outcome** is reached. Cases do not close by timeout of the chat or by the patient going silent mid-conversation; they close by explicit outcome.

**Terminal outcomes:**

| Outcome | Meaning |
|---|---|
| `booked` | `booking.apply` succeeded and backend/CRM confirmed the appointment. |
| `handed_off` | `handoff.create` succeeded and the case was transferred to human/admin handling. |
| `cancelled_by_patient` | Patient's cancellation request was confirmed by backend. |
| `unsupported_service` | The requested service cannot be served by this clinic or runtime. |
| `abandoned` | Case was opened but the patient stopped engaging without resolution. |
| `answered` | Case was a status inquiry or clarification that was fully resolved without further action. |
| `failed` | A required backend action could not be completed after appropriate retry. |
| `duplicate` | A duplicate case was identified and merged or discarded. |
| `expired` | Case reached the system-defined expiration timeout without resolution. |

Case closure must be auditable. The closing outcome must be explicit enough for an operator to understand why the case ended.

---

## 7. Status vs. Outcome

Case state has two distinct fields: `status` and `outcome`.

**`case.status`** = current lifecycle state of the case (mutable, changes as the case progresses).

**`case.outcome`** = final result of the case (set only at closure, terminal, immutable after set).

### Suggested Statuses

| Status | Meaning |
|---|---|
| `collecting` | Runtime Core is gathering operational facts from the conversation. |
| `ready_for_action` | Sufficient facts collected; a backend action can be attempted. |
| `action_in_progress` | A backend action (booking, handoff, cancellation) has been initiated. |
| `handoff` | Case is in a human/admin handoff state. |
| `closed` | Case has reached a terminal outcome. |
| `cancelled` | Case was cancelled (by patient, admin, or system). |
| `expired` | Case reached the expiration timeout. |

### Suggested Outcomes

| Outcome | Set When |
|---|---|
| `booked` | `booking.apply` confirmed success. |
| `handed_off` | `handoff.create` confirmed success. |
| `cancelled_by_patient` | Patient cancellation confirmed by backend. |
| `unsupported_service` | Service cannot be provided. |
| `abandoned` | Patient stopped engaging. |
| `answered` | Status inquiry fully resolved. |
| `failed` | Required action failed after retry. |
| `duplicate` | Case identified as duplicate. |
| `expired` | Timeout reached without resolution. |

A case in status `closed` must have an outcome set. A case with an outcome set must be in a terminal status (`closed`, `cancelled`, or `expired`).

---

## 8. AI Responsibility vs. Business Resolution

`handoff.create` transfers AI responsibility for the case to a human or admin. It does not necessarily mean the underlying business request is resolved.

For MVP:

- When `handoff.create` succeeds, the AI-owned case flow may treat the case as terminal and set outcome `handed_off`.
- Business resolution (the admin calling the patient back, the appointment being manually booked, the cancellation being processed) may happen later outside the runtime.
- Runtime Core does not need to track post-handoff business resolution for MVP.
- This simplification is acceptable for MVP because the admin workflow is outside the current runtime scope.

Post-MVP, Runtime Core may introduce a secondary tracking state for admin-side resolution of handed-off cases.

---

## 9. CRM Blocked State

Before the CRM adapter exists, the following constraints apply:

| Tool | State |
|---|---|
| `case.upsert` | Allowed — case operational state can be created and updated. |
| `case.add_note` | Allowed — notes can be added to existing cases. |
| `handoff.create` | Allowed — handoffs to human/admin can be created. |
| `availability.check` | Limited — may return `not_configured` or use a mock response. |
| `booking.apply` | **Disabled** — must return `disabled` or `not_configured` and must not create a real appointment. |

**No case may have outcome `booked` without a confirmed `booking.apply` success from the backend/CRM adapter.**

The Patient Agent must not tell a patient their appointment is confirmed while `booking.apply` is disabled or not configured. The correct behavior is to collect the booking intent, open a `booking_intake` case, and hand off to admin until CRM is available.

---

## 10. Multi-Subject Cases

One conversation may produce multiple cases when the patient requests actions for more than one person.

Each subject should have its own case. Subjects are independent operational tasks even when they originate from the same conversation.

**Example:**

> Mikhail wants a cleaning for himself and also wants to book an appointment for his friend Vasya.

This conversation should produce two cases:

| Case | Subject | Kind |
|---|---|---|
| Case A | Mikhail (self) | `booking_intake` |
| Case B | Vasya (friend of Mikhail) | `booking_intake` |

Each case tracks its own subject, service interest, preferred date/time, and lifecycle independently.

**Known multi-subject patterns:**

- `self` — booking for the patient themselves.
- `friend` — booking for a named friend.
- `child` — booking for a child.
- `partner` — booking for a partner or spouse.

Runtime Core should link related cases to the same conversation or contact session for traceability, but each case has its own status, outcome, and audit trail.

---

## 11. Non-Goals

This document defines the Case Logic contract. It intentionally excludes:

- No DB schema changes.
- No source code changes.
- No SQL changes.
- No prompt rewrites.
- No booking implementation.
- No MCP implementation.
- No Patient Agent implementation.
- No deployment changes.
- No test implementation.

---

## Acceptance

After reading this document, a developer should be able to answer:

**When to open a case?**
When the conversation contains booking intent, reschedule intent, cancel intent, process status inquiry, admin/human handoff request, or urgent request.

**When not to open a case?**
For greetings, simple FAQ, and casual clarification with no action intent.

**Who owns case state?**
Runtime Core. Patient Agent may only propose updates. Runtime Core validates and persists.

**How does a case differ from an appointment?**
A case is an operational task tracking intent and runtime state. An appointment is a confirmed calendar/CRM object produced only by a successful `booking.apply` backend execution.

**How does a case close?**
Only by a terminal outcome: `booked`, `handed_off`, `cancelled_by_patient`, `unsupported_service`, `abandoned`, `answered`, `failed`, `duplicate`, or `expired`.

**What is blocked until CRM?**
`booking.apply` is disabled. No case may reach outcome `booked`. `availability.check` may be limited or mocked. `case.upsert`, `case.add_note`, and `handoff.create` remain available.

**How do Patient Agent and Runtime Core interact around cases?**
Patient Agent proposes case updates through tools (`case.upsert`, `case.add_note`, `handoff.create`). Runtime Core validates proposals against identity, current state, and policy. Runtime Core persists approved updates and rejects invalid proposals.
