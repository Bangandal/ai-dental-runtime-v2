# Runtime systemd Operations

`runtime-v2.service` is the systemd unit that manages the AI dental runtime on the production server (`139.59.183.85`). It auto-starts on boot and auto-restarts on failure.

## Approval gate

Every mutating service command requires an explicit owner approval phrase before the operator may run it.

| Action | Required phrase |
|---|---|
| `systemctl restart runtime-v2.service` | `APPROVED: restart runtime` |
| `systemctl start runtime-v2.service` | `APPROVED: start runtime` |
| `systemctl stop runtime-v2.service` | `APPROVED: stop runtime` |
| Kill a conflicting process on port 3000 | `APPROVED: stop conflicting runtime process` or `APPROVED: restart runtime` |
| `systemctl daemon-reload` (after service file change) | `APPROVED: restart runtime` |
| `systemctl enable/disable runtime-v2.service` | `APPROVED: restart runtime` |

The following are **read-only** and do not require approval:

- `systemctl status runtime-v2.service`
- `journalctl` (any flags)
- `curl http://localhost:3000/health`
- `ss -tlnp`

## Service file location

```
/etc/systemd/system/runtime-v2.service
```

Reference copy: [`deploy/runtime-v2.service`](../deploy/runtime-v2.service)

## Key configuration

| Field | Value |
|---|---|
| `User` | `runtime-agent` |
| `WorkingDirectory` | `/opt/runtime-v2/app` |
| `EnvironmentFile` | `/opt/runtime-v2/app/.env` |
| `ExecStart` | `/usr/bin/npm start` |
| `Restart` | `on-failure` with `RestartSec=5` |
| `StandardOutput/Err` | `journal` (journald) |

## Read-only status checks (no approval needed)

```bash
# Service status
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service

# Health endpoint
curl http://localhost:3000/health

# Port binding
ss -tlnp | grep :3000
```

Note: `SYSTEMD_PAGER=''` suppresses the `less` pager, required in non-interactive SSH sessions.

## Viewing logs (no approval needed)

```bash
# Last 50 lines
journalctl -u runtime-v2.service --no-pager -n 50

# Follow live
journalctl -u runtime-v2.service -f

# Since last boot
journalctl -u runtime-v2.service -b
```

`journalctl` works without sudo only if `runtime-agent` is a member of the `systemd-journal` group (see installation section). Until that group is added, use `sudo journalctl`.

## Deploying a new version

```bash
cd /opt/runtime-v2/app

# 1. Pull new code
git pull origin ai-dental-frontdesk-core

# 2. Install deps (if package.json changed)
npm ci --omit=dev

# 3. Only after receiving explicit "APPROVED: restart runtime" from owner:
sudo /bin/systemctl restart runtime-v2.service

# 4. Verify (no approval needed)
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service
curl http://localhost:3000/health
```

## Health check (no approval needed)

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## Environment file

Secrets live in `/opt/runtime-v2/app/.env` (chmod 600, owned by `runtime-agent`).

Required vars: see `.env.example` in the repo root.

To update a secret: edit `.env`, then request `APPROVED: restart runtime` before running `sudo /bin/systemctl restart runtime-v2.service`.

## Recovery: if the service is stuck in failed state

This can happen if another process (e.g. a leftover nohup) is holding port 3000.

```bash
# 1. Identify the conflicting process (no approval needed)
ss -tlnp | grep :3000

# 2. Only after receiving "APPROVED: stop conflicting runtime process"
#    or "APPROVED: restart runtime" from owner:
kill <PID>

# 3. Systemd will auto-restart within RestartSec=5s.
#    If it does not, only after receiving "APPROVED: restart runtime":
sudo /bin/systemctl restart runtime-v2.service

# 4. Verify (no approval needed)
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service
curl http://localhost:3000/health
```

## Installing the service file on a new server

```bash
# Copy unit file
sudo cp deploy/runtime-v2.service /etc/systemd/system/runtime-v2.service
sudo systemctl daemon-reload
sudo systemctl enable runtime-v2.service
sudo systemctl start runtime-v2.service

# Allow runtime-agent to run journalctl without sudo
sudo usermod -aG systemd-journal runtime-agent
# runtime-agent must re-login for the group membership to take effect.
# Until then, use: sudo journalctl -u runtime-v2.service
```

Add the `runtime-agent` sudoers rule:

```
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl start runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl stop runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl restart runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl status runtime-v2.service
```
