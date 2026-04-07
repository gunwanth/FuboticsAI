# Render Docker Deployment

This repo can now be deployed fully on Render using Docker-based services:

- `fubotics-chat-frontend` as a Docker web service
- `fubotics-chat-backend` as a Docker web service
- `fubotics-dino-mcp` as a Docker private service
- `fubotics-postgres` as a managed Render Postgres database

## Files Used

- [render.yaml](d:/fubotics%20chat%20bot/render.yaml)
- [fubotics-chat-frontend/Dockerfile](d:/fubotics%20chat%20bot/fubotics-chat-frontend/Dockerfile)
- [fubotics-chat-backend/Dockerfile](d:/fubotics%20chat%20bot/fubotics-chat-backend/Dockerfile)
- [fubotics-chat-backend/mcp-server/Dockerfile](d:/fubotics%20chat%20bot/fubotics-chat-backend/mcp-server/Dockerfile)

## Important Runtime Change

The frontend no longer depends only on Vite build-time envs in Docker.

At container startup it now:

- reads `VITE_API_BASE_URL`
- writes `/env-config.js`
- configures Nginx to listen on Render's injected `PORT`

This makes the frontend Docker image Render-friendly.

## Deploy Steps

1. Push this repo to GitHub.
2. In Render, choose `New` -> `Blueprint`.
3. Connect the repo and deploy [render.yaml](d:/fubotics%20chat%20bot/render.yaml).
4. Render will create:
   - `fubotics-chat-frontend`
   - `fubotics-chat-backend`
   - `fubotics-dino-mcp`
   - `fubotics-postgres`

## Required Render Environment Values

Frontend:

- `VITE_API_BASE_URL`

Set it to your backend public Render URL, for example:

```env
VITE_API_BASE_URL=https://fubotics-chat-backend.onrender.com
```

Backend:

- `JWT_SECRET`
- `FRONTEND_PUBLIC_URL`
- `BACKEND_PUBLIC_URL`
- `FRONTEND_ORIGINS`
- `GROQ_API_KEY`
- `HUGGINGFACE_API_KEY` or `HF_TOKEN`
- optional image-provider keys

Dino MCP:

- `GROQ_API_KEY`
- `HUGGINGFACE_API_KEY` or `HF_TOKEN`

## Recommended URL Values

Backend:

```env
FRONTEND_PUBLIC_URL=https://fubotics-chat-frontend.onrender.com
BACKEND_PUBLIC_URL=https://fubotics-chat-backend.onrender.com
FRONTEND_ORIGINS=https://fubotics-chat-frontend.onrender.com
```

If you later add a custom domain, include it in `FRONTEND_ORIGINS` too.

## What Still Needs Your Account

I prepared the deployment files in the repo, but I still cannot perform the live Render deploy from this session because that requires your Render account authorization.
