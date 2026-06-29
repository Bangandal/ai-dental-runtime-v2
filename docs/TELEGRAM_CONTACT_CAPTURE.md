# Telegram Contact Capture

Support for Telegram-native phone capture using `KeyboardButton request_contact=true`.

This is preparation infrastructure for the future `booking.apply` flow. **No ClinicCard write operations are performed in this feature.**

---

## Why phone is needed

`booking.apply` (not yet implemented) requires `phone_number` before `createPatient`/`createVisit` — the clinic needs a reliable contact channel for confirmation, changes, and patient identification. See `docs/CLINICCARD_BOOKING_APPLY_CONTRACT.md §2` for the full phone policy.

## Telegram does not provide phone automatically

Telegram does **not** expose the user's phone number via the regular message API. The patient must **explicitly tap a contact sharing button** to share their number. The runtime cannot capture phone without this consent action.

Contact sharing only works in **private chats** (`chat.type === "private"`). It is not available in groups or channels.

---

## How it works

### Outgoing: requesting the contact button

When the runtime determines that phone is needed, the agent response may include:

```json
{
  "final_patient_reply": "Чтобы клиника могла подтвердить запись, поделитесь, пожалуйста, номером телефона кнопкой ниже.",
  "ui": {
    "telegram": {
      "request_contact": true,
      "button_text": "📞 Поделиться номером"
    }
  }
}
```

The Telegram route translates this into a `reply_markup` sent alongside the text:

```json
{
  "keyboard": [[{ "text": "📞 Поделиться номером", "request_contact": true }]],
  "resize_keyboard": true,
  "one_time_keyboard": true
}
```

`reply_markup` is not exposed to the patient as text — only the button appears in the Telegram UI.

### Incoming: patient taps the button

Telegram sends a `message.contact` update to the webhook. The adapter normalizes it:

```json
{
  "phone_number": "+380991234567",
  "phone_source": "telegram_contact_button",
  "phone_consent": true,
  "phone_collected_at": "2026-06-29T10:00:00.000Z",
  "telegram_contact": {
    "phone_number": "+380991234567",
    "first_name": "Olga",
    "last_name": "Petrenko",
    "user_id": 444
  }
}
```

---

## Stored fields (`TelegramContactCapture`)

| Field | Value | Notes |
|---|---|---|
| `phone_number` | E.164 string | Provided by Telegram, not validated by runtime |
| `phone_source` | `"telegram_contact_button"` | Always set for Telegram contact button |
| `phone_consent` | `true` | Patient explicitly tapped the button |
| `phone_collected_at` | ISO 8601 | Timestamp of the incoming update |
| `telegram_contact.phone_number` | string | Raw Telegram field |
| `telegram_contact.first_name` | string? | May differ from profile name |
| `telegram_contact.last_name` | string? | Optional |
| `telegram_contact.user_id` | number? | Telegram user ID if present |

If `phone_number` is absent in the Telegram contact payload, the update is treated as a failed capture (`no_contact_phone`) and no phone is stored.

---

## Persistence gap

As of this PR, the `TelegramContactCapture` is normalized but **not yet wired to the booking pipeline**. The contact update returns HTTP 200 without calling the LLM or the orchestrator.

When `booking.apply` is implemented, the persistence path will:
1. Link the captured phone to the patient's case via `contact_id` / `collected` fields
2. Advance the booking intake flow automatically after phone capture

This gap is intentional — no risky persistence changes are added here.

---

## Patient-facing language

When requesting the contact button, the allowed phrase is:

> "Чтобы клиника могла подтвердить запись, поделитесь, пожалуйста, номером телефона кнопкой ниже."

Forbidden (before ClinicCard proof):
- "запись создана"
- "мы вас записали"
- "подтверждено"
- Any claim that ClinicCard booking exists

---

## Idempotency

Duplicate Telegram updates with the same `update_id` are handled by the existing deduplication path (`registerInboundEvent`). Contact updates currently return 200 immediately, so duplicate contact shares do not create duplicate side effects.

---

## What this PR does NOT include

- `booking.apply` implementation
- ClinicCard `createPatient` or `createVisit`
- `CLINICCARD_BOOKING_MODE` live write path
- WhatsApp contact capture (documented in `CLINICCARD_BOOKING_APPLY_CONTRACT.md §2` as adapter-specific)
- SQL migrations
