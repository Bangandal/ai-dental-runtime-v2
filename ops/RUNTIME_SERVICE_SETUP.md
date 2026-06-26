# Runtime V2 — Service Setup

This document describes how to install and manage `runtime-v2.service` as a systemd service on the production server.

## Prerequisites

- Server: Ubuntu/Debian with systemd
- App deployed at: `/opt/runtime-v2/app`
- `.env` present at: `/opt/runtime-v2/app/.env`
- Node.js ≥ 22 available at `/usr/bin/node`
- npm available at `/usr/bin/npm`
- User `runtime-agent` exists

### Log access prerequisite (root, run once)

`runtime-agent` reads journald logs without sudo via group membership:

```bash
sudo usermod -aG systemd-journal runtime-agent
# Re-login or new session required for group to take effect
```

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

# 4. Reload systemd and enable service (does NOT start it)
systemctl daemon-reload
systemctl enable runtime-v2.service

# 5. Verify service is registered (not yet started)
systemctl status runtime-v2.service || true
```

Runtime is **not started automatically**. Start only after explicit owner approval (see below).

---

## Starting Runtime After Approval

The Server Operator must receive the following phrase from the owner before starting:

```
APPROVED: start runtime
```

Once received:

```bash
sudo systemctl start runtime-v2.service
sudo systemctl status runtime-v2.service
journalctl -u runtime-v2.service -n 100 --no-pager
```

---

## Operator Commands (runtime-agent, after root install)

Check status:
```bash
sudo systemctl status runtime-v2.service
```

Read logs (last 100 lines, no sudo required):
```bash
journalctl -u runtime-v2.service -n 100 --no-pager
```

Stream logs live:
```bash
journalctl -u runtime-v2.service -f
```

### Controlled restart/stop — requires explicit approval phrase

The Server Operator must receive one of these phrases before executing:

- `APPROVED: start runtime`
- `APPROVED: restart runtime`
- `APPROVED: stop runtime`

```bash
# Only after APPROVED: restart runtime
sudo systemctl restart runtime-v2.service

# Only after APPROVED: stop runtime
sudo systemctl stop runtime-v2.service
```

The operator must never self-initiate start, restart, or stop without this phrase.

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
- **journald**: `journalctl -u runtime-v2.service` (no sudo — requires systemd-journal group)
- **File**: `./logs/` directory (configured via `RUNTIME_LOG_DIR` in `.env`)

---

## Security Notes

- `runtime-agent` cannot edit `.env`, service files, or run `daemon-reload`
- `runtime-agent` cannot run arbitrary `sudo` commands
- `journalctl` does not require sudo — access via `systemd-journal` group membership
- Service runs with `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full`
- All secrets stay in `.env` — never printed, never logged
