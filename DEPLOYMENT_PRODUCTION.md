# Production Deployment Layout

This repo now has a Docker-first production layout for the main app stack:

- `caddy`: HTTPS reverse proxy with automatic certificates
- `frontend`: Vite-built React app served by Nginx
- `backend`: Express API
- `dino-mcp`: Dino MCP HTTP bridge
- `postgres`: PostgreSQL

## What This Solves

- Keeps Dino MCP on as a persistent sidecar instead of waking it ad hoc
- Gives the backend a stable internal MCP URL: `http://dino-mcp:5051`
- Terminates HTTPS at Caddy and routes traffic by domain
- Adds health endpoints for the backend and health checks for all services
- Persists uploads, generated files, and attachments in named Docker volumes

## Files Added

- [docker-compose.prod.yml](d:/fubotics%20chat%20bot/docker-compose.prod.yml)
- [deploy/Caddyfile](d:/fubotics%20chat%20bot/deploy/Caddyfile)
- [deploy-vps.sh](d:/fubotics%20chat%20bot/deploy-vps.sh)
- [fubotics-chat-backend/Dockerfile](d:/fubotics%20chat%20bot/fubotics-chat-backend/Dockerfile)
- [fubotics-chat-frontend/Dockerfile](d:/fubotics%20chat%20bot/fubotics-chat-frontend/Dockerfile)
- [.env.production.example](d:/fubotics%20chat%20bot/.env.production.example)

## Start Locally In Production Mode

1. Copy the env file.

```powershell
Copy-Item .env.production.example .env.production
```

2. Fill in real values for at least:

- `APP_DOMAIN`
- `API_DOMAIN`
- `ACME_EMAIL`
- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `PGPASSWORD`
- `GROQ_API_KEY`
- `FRONTEND_PUBLIC_URL`
- `BACKEND_PUBLIC_URL`
- `FRONTEND_ORIGINS`
- `VITE_API_BASE_URL`

3. Point your DNS records to the VPS:

- `A` record for `APP_DOMAIN` -> your server IP
- `A` record for `API_DOMAIN` -> your server IP

4. Start the stack.

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml up --build -d
```

Or on a Linux VPS:

```bash
chmod +x deploy-vps.sh
./deploy-vps.sh
```

5. Check status.

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f
```

## Public URLs

- Frontend: `https://APP_DOMAIN`
- Backend health: `https://API_DOMAIN/health`
- Backend readiness: `https://API_DOMAIN/ready`

`frontend`, `backend`, and `dino-mcp` are internal-only on the Docker network. Caddy is the only public entrypoint.

## Scaling Notes

This layout is production-ready for a single-node deployment. For true horizontal scaling, there are two current boundaries in this codebase:

1. Local file storage

The backend writes runtime files into:

- `/app/uploads`
- `/app/attachments`
- `/app/generated`

With multiple backend replicas, those need shared storage such as:

- S3-compatible object storage
- NFS / shared volume
- a dedicated file service

2. In-memory process behavior

Session-level transient behavior and local process fallbacks still assume a stable backend instance. Multiple backend replicas are possible, but the clean next step would be:

- keep Dino MCP as a dedicated service
- move file artifacts to object storage
- put the backend behind a reverse proxy or load balancer
- use managed Postgres

## Recommended Production Shape

- `caddy`: public reverse proxy with HTTPS
- `frontend`: internal web container
- `backend`: 1-2 replicas behind a reverse proxy
- `dino-mcp`: 1 replica, always on
- `postgres`: managed database preferred
- `image worker`: separate optional service if local image generation is required

## Git / Deployment Note

These files make the project much easier to deploy from Git, but they do not push to Git automatically. If you want, the next step is either:

1. commit just the deployment files
2. wire a platform-specific deploy target like Render, Railway, Fly.io, or VPS Docker Compose
