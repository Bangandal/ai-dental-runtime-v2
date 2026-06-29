# Runtime systemd Operations

`runtime-v2.service` is the systemd unit that manages the AI dental runtime on the production server (`139.59.183.85`). It auto-starts on boot and auto-restarts on failure.

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

## Daily operations (no root required)

`runtime-agent` has `sudo NOPASSWD` for four systemctl verbs only:

```bash
# Status
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service

# Restart (after deploy or config change)
sudo /bin/systemctl restart runtime-v2.service

# Stop / start
sudo /bin/systemctl stop runtime-v2.service
sudo /bin/systemctl start runtime-v2.service
```

Note: `SYSTEMD_PAGER=''` suppresses the `less` pager, which is required in non-interactive SSH sessions. Without it, `sudo -n status` fails with "a terminal is required."

## Viewing logs

```bash
# Last 50 lines
journalctl -u runtime-v2.service --no-pager -n 50

# Follow live
journalctl -u runtime-v2.service -f

# Since last boot
journalctl -u runtime-v2.service -b
```

`journalctl` works without sudo for `runtime-agent` because the service runs as that user.

## Deploying a new version

```bash
cd /opt/runtime-v2/app

# 1. Pull new code
git pull origin ai-dental-frontdesk-core

# 2. Install deps (if package.json changed)
npm ci --omit=dev

# 3. Restart via systemd
sudo /bin/systemctl restart runtime-v2.service

# 4. Verify
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service
curl http://localhost:3000/health
```

## Health check

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## Environment file

Secrets live in `/opt/runtime-v2/app/.env` (chmod 600, owned by `runtime-agent`).

Required vars: see `.env.example` in the repo root.

To update a secret: edit `.env` then `sudo /bin/systemctl restart runtime-v2.service`.

## Recovery: if the service is stuck in failed state

This can happen if another process (e.g. a leftover nohup) is holding port 3000:

```bash
# 1. Find the process on port 3000
ss -tlnp | grep :3000

# 2. Kill it (if it belongs to runtime-agent)
kill <PID>

# 3. Systemd will auto-restart within RestartSec=5s
# Or force it:
sudo /bin/systemctl restart runtime-v2.service

# 4. Verify
SYSTEMD_PAGER='' sudo -n /bin/systemctl status runtime-v2.service
```

## Installing the service file on a new server

```bash
sudo cp deploy/runtime-v2.service /etc/systemd/system/runtime-v2.service
sudo systemctl daemon-reload
sudo systemctl enable runtime-v2.service
sudo systemctl start runtime-v2.service
```

Then add the `runtime-agent` sudoers rule:

```
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl start runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl stop runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl restart runtime-v2.service
runtime-agent ALL=(root) NOPASSWD: /bin/systemctl status runtime-v2.service
```
