# Admin Notification / Handoff Contract

## 1. Core Principle

Admin notification is a **runtime side effect**, not an agent tool.

- `admin.notify` is never called directly by the Patient Agent or Operator Agent.
- `admin.notify` is derived by `deriveRuntimeSideEffects(...)` from confirmed backend events.
- Runtime Core records the notification intent and may audit the delivery result if reported back.
- **Runtime Core does not directly send or deliver the Telegram message.**
- The n8n / transport adapter reads the notification intent and delivers the actual message to the admin channel.
- The agent proposes handoff through `handoff.create`.
- Runtime Core validates and executes `handoff.create`.
- Only after `handoff.create` succeeds does Runtime Core derive and record the `admin.notify` notification intent.

This separation means: the agent cannot trigger admin notifications directly, a notification intent is never recorded for a handoff that did not succeed, and the delivery transport is decoupled from Runtime Core.

---

## 2. What Triggers an Admin Notification

An admin notification is triggered when Runtime Core confirms one of the following backend events:

| Trigger Event | Description |
|---|---|
| `handoff.create` success | A handoff case was successfully created and persisted. |
| `urgent` case open | An urgent case was opened by Runtime Core (clinical emergency or patient-declared urgency). |

An admin notification is **not** triggered by:

- A patient message alone.
- An agent proposal that was not yet validated by Runtime Core.
- A `handoff.create` call that returned an error or was rejected.
- FAQ, greeting, or casual conversation with no case outcome.
- Case updates that do not produce a terminal or escalation event.

---

## 3. Handoff Trigger Path

```
Patient message
  → Patient Agent proposes handoff (handoff.create tool call)
  → Runtime Core validates: contact identity, case state, policy gates
  → Runtime Core persists handoff case with outcome = handed_off
  → Runtime Core derives and records admin.notify notification intent
  → n8n / transport adapter reads notification intent
  → n8n / transport adapter delivers Telegram message to admin
  → Runtime Core may log/audit delivery result if reported back
```

The Patient Agent receives a tool result confirming `handoff.create` success. It may then inform the patient that their request has been passed to the clinic team.

---

## 4. Notification Payload

Every admin notification must include:

| Field | Description |
|---|---|
| `case_id` | The unique ID of the handoff case. |
| `case_kind` | The operational type of the case (`admin_handoff`, `urgent`, etc.). |
| `contact_id` | The contact who initiated the case. |
| `contact_display` | A human-readable contact identifier (phone, name, or channel reference). |
| `channel` | The channel the patient used (e.g., `telegram`, `whatsapp`, `web`). |
| `handoff_reason` | Why the handoff was created (patient request, urgency, unsupported service, or runtime-determined). |
| `subject_kind` | Who the case is about (`self`, `child`, `friend`, `partner`, `other`). |
| `subject_display_name` | Display name of the subject if provided. |
| `service_interest` | Service the patient is requesting, if known. |
| `preferred_date` | Patient's stated preferred date, if provided. |
| `preferred_time` | Patient's stated preferred time, if provided. |
| `urgency` | Whether urgency was declared. |
| `case_created_at` | Timestamp when the case was created. |
| `notes` | Any additional operational notes on the case. |

Optional fields may be omitted if not collected. Required fields (`case_id`, `case_kind`, `contact_id`, `handoff_reason`) must always be present.

---

## 5. Notification Channels

For MVP, the admin notification is delivered to **Telegram** via the **n8n / transport adapter**.

Runtime Core does not directly connect to Telegram. It records the notification intent. The n8n / transport adapter reads the intent and delivers the message.

| Channel | MVP Status | Delivered by |
|---|---|---|
| Telegram | Active | n8n / transport adapter (Roadmap step 11) |
| Email | Not implemented | Future |
| SMS | Not implemented | Future |
| In-app dashboard | Not implemented | Future |

Notification channel configuration (Telegram bot token, admin chat ID) is environment-specific and must not be hardcoded in runtime contracts. Configuration is provided via environment variables and consumed by the transport adapter, not by Runtime Core directly.

---

## 6. Notification Message Format

The admin notification message must be concise and actionable. The minimum required format:

```
🦷 [case_kind] — [handoff_reason]

Contact: [contact_display] via [channel]
Subject: [subject_kind] — [subject_display_name if known]
Service: [service_interest if known]
Preferred: [preferred_date] [preferred_time if known]
Urgency: [yes/no]
Notes: [notes if present]

Case ID: [case_id]
Created: [case_created_at]
```

For `urgent` cases, the message should include a visual escalation marker (e.g., `⚠️ URGENT`).

Notification messages must not contain:
- Full conversation transcripts.
- Patient PII beyond what is listed in the payload above.
- Internal runtime debug data.

---

## 7. Admin Workflow (MVP)

After receiving a notification, the admin is expected to act outside the runtime system.

For MVP, Runtime Core does not track post-notification admin actions.

Expected admin steps:
1. Receive the notification on the configured channel.
2. Identify the patient using `contact_display` and `channel`.
3. Contact the patient directly (call, message) to handle the request.
4. Manually book, cancel, or resolve the request in the CRM if applicable.

Runtime Core does not know whether the admin has acted. Post-handoff resolution is a manual admin responsibility in MVP.

---

## 8. Retry and Failure Behavior

If the transport adapter reports a notification delivery failure, or if the notification intent is never picked up:

- The `handoff.create` case outcome remains `handed_off` — the case is already persisted.
- The notification intent remains recorded in Runtime Core.
- Delivery failure must be logged as a runtime error (by the transport adapter or via callback to Runtime Core).
- Runtime Core may audit the delivery result if reported back by the transport adapter.
- Retry responsibility belongs to the transport adapter layer, not Runtime Core.
- The Patient Agent is not informed of notification delivery failure.
- The patient-facing response must not claim that the admin was notified if delivery failed.

Retry behavior details (max attempts, backoff strategy) are transport adapter implementation concerns and are not defined in this contract.

---

## 9. Urgent Case Escalation

When Runtime Core opens an `urgent` case, an admin notification must be dispatched immediately — without waiting for a completed `handoff.create`.

Urgency escalation path:

```
Patient message triggers urgent case
  → Runtime Core opens urgent case
  → Runtime Core derives and records admin.notify notification intent immediately
  → n8n / transport adapter reads notification intent and delivers to admin channel
  → Runtime Core may log/audit delivery result if reported back
  → Patient Agent informs patient that urgent request was received
```

For urgent cases, the notification payload must include `urgency: true` and the `⚠️ URGENT` marker in the message.

`handoff.create` may still be called for an urgent case to formally record the handoff outcome, but the notification is not blocked on it.

---

## 10. CRM-Blocked State

Admin notifications are available before the CRM adapter exists.

| State | Admin Notification |
|---|---|
| CRM not configured | ✅ Available — `handoff.create` works, notification intent recorded |
| CRM configured | ✅ Available |
| `booking.apply` disabled | ✅ Not affected — notification does not depend on booking |

Admin notifications must not include a confirmed booking reference while `booking.apply` is disabled or not configured. The notification should reflect the actual case outcome (`handed_off`), not a booking outcome.

---

## 11. Permission Model

| Action | Class | Who may perform |
|---|---|---|
| Propose `handoff.create` | Proposal | Patient Agent |
| Execute `handoff.create` | Runtime Core executor | Runtime Core only |
| Derive and record `admin.notify` notification intent | Side effect | Runtime Core only (`deriveRuntimeSideEffects`) |
| Deliver notification to admin channel | Transport | n8n / transport adapter |
| Log/audit delivery result | Audit | Runtime Core (if result reported back by adapter) |
| Configure notification channel | Protected / env config | Owner via environment variables (consumed by transport adapter) |
| Read notification logs | Read-only | Operator Agent |

The Operator Agent may read notification logs and case state. It may not directly trigger `admin.notify` or reconfigure notification channels without owner approval.

---

## 12. Non-Goals

This contract intentionally does not define or implement:

- Admin reply-back or two-way conversation with admin via notification channel.
- Notification deduplication logic.
- Admin acknowledgement tracking.
- Post-handoff case resolution tracking.
- Email, SMS, or webhook notification channels (future).
- In-app admin dashboard.
- Booking confirmation notifications (different contract, depends on CRM).
- Patient-facing notification of admin response.

---

## Acceptance

After this document exists, a developer should be able to answer:

**What triggers an admin notification?**
`handoff.create` success or an urgent case opening by Runtime Core.

**Who sends the notification?**
Runtime Core derives and records the `admin.notify` notification intent via `deriveRuntimeSideEffects`. The n8n / transport adapter delivers the actual message to the admin channel. Runtime Core does not directly send or deliver the Telegram message. The agent never triggers notification directly.

**What is in the notification?**
`case_id`, `case_kind`, `contact_id`, `contact_display`, `channel`, `handoff_reason`, `subject_kind`, `service_interest`, `preferred_date`, `urgency`, `notes`, and `case_created_at`.

**What channel is used in MVP?**
Telegram. Channel configuration is provided via environment variables.

**What does the admin do after receiving a notification?**
Contacts the patient directly and resolves the request manually. Runtime Core does not track post-handoff resolution in MVP.

**What happens if notification delivery fails?**
The handoff case outcome remains `handed_off`. The failure is logged. Retry is attempted up to the defined limit. The patient-facing response must not claim admin was notified if delivery failed.

**Is admin notification available before CRM is configured?**
Yes. It does not depend on `booking.apply` or the CRM adapter.
