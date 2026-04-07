# Docker Deployment Without A Domain

If you do not have a domain yet, deploy the stack directly on your VPS IP over HTTP.

Use:

- [docker-compose.ip.yml](d:/fubotics%20chat%20bot/docker-compose.ip.yml)
- [deploy-vps.sh](d:/fubotics%20chat%20bot/deploy-vps.sh) only as a reference for the normal compose flow

## 1. Find Your VPS Public IP

From the VPS:

```bash
curl ifconfig.me
```

Assume it returns:

```text
203.0.113.10
```

## 2. Set `.env.production`

Use HTTP and the raw IP:

```env
FRONTEND_PUBLIC_URL=http://203.0.113.10:8080
BACKEND_PUBLIC_URL=http://203.0.113.10:5001
VITE_API_BASE_URL=http://203.0.113.10:5001
FRONTEND_ORIGINS=http://203.0.113.10:8080
```

You do not need:

- `APP_DOMAIN`
- `API_DOMAIN`
- `ACME_EMAIL`

for the no-domain flow.

## 3. Start The Stack

```bash
docker compose --env-file .env.production -f docker-compose.ip.yml up -d --build
```

## 4. Open The App

- Frontend: `http://203.0.113.10:8080`
- Backend health: `http://203.0.113.10:5001/health`

## 5. Security Note

This mode is for testing or early deployment only:

- no HTTPS
- browser traffic is plain HTTP
- cookies and auth still work, but this is not ideal for internet-facing long-term production

When you get a domain later, switch to:

- [docker-compose.prod.yml](d:/fubotics%20chat%20bot/docker-compose.prod.yml)
- Caddy
- HTTPS
