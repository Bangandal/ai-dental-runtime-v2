# Runtime V2 — Service Setup

This document describes how to install and manage `runtime-v2.service` as a systemd service on the production server.

## Prerequisites

- Server: Ubuntu/Debian with systemd
- App deployed at: `/opt/runtime-v2/app`
- `.env` present at: `/opt/runtime-v2/app/.env`
- Node.js ≥ 22 available at `/usr/bin/node`
- npm available at `/usr/bin/npm`
- User `runtime-agent` exists

---

## Root Install (run once, as root)

```bash
# 1. Copy service template
cp /opt/runtime-v2/app/ops/runtime-v2.service.template /etc/systemd/system/runtime-v2.service

# 2. Copy and harden sudoers file
cp /opt/runtime-v2/app/ops/runtime-agent-sudoers.template /etc/sudoers.d/runtime-agent
chmod 440 /etc/sudoers.d/runtime-agent

# 3. Validate sudoers (must return OK before proceeding)
visudo -cf /etc/sudoers.d/runtime-agent

# 4. Reload systemd and enable service
systemctl daemon-reload
systemctl enable runtime-v2.service

# 5. Start service
systemctl start runtime-v2.service

# 6. Verify
systemctl status runtime-v2.service
journalctl -u runtime-v2.service -n 100 --no-pager
```

---

## Operator Commands (runtime-agent, after root install)

Check status:
```bash
sudo systemctl status runtime-v2.service
```

Read logs (last 100 lines):
```bash
journalctl -u runtime-v2.service -n 100 --no-pager
```

Stream logs live:
```bash
journalctl -u runtime-v2.service -f
```

### Controlled restart — requires explicit approval phrase

The Server Operator must receive one of the following phrases from the owner before executing:

- `APPROVED: start runtime`
- `APPROVED: restart runtime`
- `APPROVED: stop runtime`

```bash
# Only after APPROVED: restart runtime
sudo systemctl restart runtime-v2.service
```

The operator must never self-initiate a restart without this phrase.

---

## Health Check (after service is running)

```bash
curl -s http://localhost:3000/health
# Expected: {"ok":true}
```

If `PORT` in `.env` differs from 3000, substitute accordingly.

---

## Updating Code

After a PR is merged into `ai-dental-frontdesk-core`:

```bash
# 1. Pull (runtime-agent)
cd /opt/runtime-v2/app && git pull --ff-only

# 2. Run tests
npm test

# 3. Only after APPROVED: restart runtime
sudo systemctl restart runtime-v2.service

# 4. Verify health
curl -s http://localhost:3000/health
```

---

## Log Location

Logs are written to:
- **journald**: `journalctl -u runtime-v2.service`
- **File**: `./logs/` directory (configured via `RUNTIME_LOG_DIR` in `.env`)

---

## Security Notes

- `runtime-agent` cannot edit `.env`, service files, or run `daemon-reload`
- `runtime-agent` cannot run arbitrary `sudo` commands
- Service runs with `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full`
- All secrets stay in `.env` — never printed, never logged
