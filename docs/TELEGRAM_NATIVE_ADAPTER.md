# Telegram Native Adapter

Native Telegram webhook handler built into runtime-v2. Replaces n8n as the Telegram transport layer.

## How it works

```
Telegram → POST /webhooks/telegram → runtime-v2 → Telegram Bot API (sendMessage)
```

The adapter:
1. Verifies `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`
2. Normalizes the Telegram update into a runtime turn input
3. Calls the same internal LLM service as `/runtime/turn`
4. Sends `final_patient_reply` back via `sendMessage` — no debug/internals exposed

## Env vars

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes (if Telegram enabled) | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Yes in production | Secret to verify Telegram calls. Set via `setWebhook` |
| `TELEGRAM_DEFAULT_CLINIC_CODE` | No (default: `clinic_1`) | Clinic code used for all Telegram turns |

If `TELEGRAM_BOT_TOKEN` is not set, the webhook route is not registered and Telegram is disabled.

In **production**, both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are required. Missing either will throw at startup.

## Webhook registration

After deploying, register the webhook with Telegram once:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-domain>/webhooks/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Verify it was registered:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## Smoke test (local dev)

With `NODE_ENV` not set to `production`, the secret check is bypassed in dev:

```bash
curl -X POST http://localhost:3000/webhooks/telegram \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "chat": {"id": 123456, "type": "private"},
      "from": {"id": 123456, "first_name": "Test"},
      "text": "Сколько стоит чистка?"
    }
  }'
```

Expected: `{"ok":true}`. The reply goes to Telegram chat 123456 (requires valid `TELEGRAM_BOT_TOKEN`).

## Rollback to n8n

If you need to stop using the native adapter and go back to n8n:

1. Remove or unset `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from your env
2. Restart the runtime — the `/webhooks/telegram` route will not be registered
3. In n8n, re-enable your existing Telegram Trigger workflow
4. In Telegram, re-point the webhook to n8n's URL:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<n8n-host>/webhook/<n8n-path>"
   ```

## Production notes

- The route always returns HTTP 200 to Telegram to prevent retry loops, even on internal errors
- `sendMessage` is fire-and-forget — HTTP 200 is returned before the Telegram API call resolves
- Edited messages, non-text updates, and updates without a sender are silently ignored (200, no LLM call)
- No ClinicCard write actions are triggered from this adapter — read-only runtime only
- The bot token is never logged or included in responses
- **nginx**: expose `/webhooks/telegram` via the nginx reverse proxy — see `docs/SECURITY_HARDENING.md` for the required `location` block
