# Runtime Security Hardening

MVP pilot checklist for `runtime-v2` on a shared server (n8n + runtime on same host).

---

## 1. Required env vars

Add to `/opt/runtime-v2/app/.env`:

```env
# Shared secret between n8n and the runtime. Generate with:
#   openssl rand -hex 32
RUNTIME_API_KEY=<your-secret>

# Set in production to strip internal debug fields from API responses.
# Remove or set to "false" to hide debug output.
RUNTIME_DEBUG_RESPONSE=false
```

Restart the runtime after changing env:

```bash
sudo systemctl restart runtime-v2
```

---

## 2. Bind runtime to localhost only

Edit `/opt/runtime-v2/app/src/main.ts` line:

```typescript
// Change:
await app.listen({ port, host: "0.0.0.0" });

// To:
await app.listen({ port, host: "127.0.0.1" });
```

This prevents direct public access on port 3000. Traffic must flow through nginx.

Rebuild and restart after the change.

---

## 3. Nginx reverse proxy

Install nginx if not present:

```bash
sudo apt install nginx
```

Create `/etc/nginx/sites-available/runtime-v2`:

```nginx
server {
    listen 443 ssl;
    server_name <your-domain>;

    # SSL certs (Let's Encrypt recommended)
    ssl_certificate     /etc/letsencrypt/live/<your-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<your-domain>/privkey.pem;

    # Rate limit at nginx level (defence-in-depth)
    limit_req_zone $binary_remote_addr zone=runtime_limit:10m rate=30r/m;

    location /runtime/turn {
        limit_req zone=runtime_limit burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/runtime-v2 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 4. Firewall rules

Allow only SSH, HTTP, HTTPS. Block direct access to port 3000:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw enable
```

Verify:

```bash
sudo ufw status
```

---

## 5. n8n header configuration

All calls from n8n to `/runtime/turn` must include:

```
Authorization: Bearer <RUNTIME_API_KEY>
```

or alternatively:

```
X-Runtime-API-Key: <RUNTIME_API_KEY>
```

In n8n HTTP Request node: set **Authentication** to **Header Auth**,
Header Name: `Authorization`, Header Value: `Bearer <your-secret>`.

---

## 6. Verify after deploy

```bash
# Should return 401 (no key)
curl -s -X POST https://<your-domain>/runtime/turn \
  -H "Content-Type: application/json" \
  -d '{"clinic_code":"clinic_1","channel":"web","external_user_id":"test","text":"hi"}' | jq .

# Should succeed (with key)
curl -s -X POST https://<your-domain>/runtime/turn \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <RUNTIME_API_KEY>" \
  -d '{"clinic_code":"clinic_1","channel":"web","external_user_id":"test","text":"hi"}' | jq .reply_text
```
