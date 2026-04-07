# Render + Vercel Deployment

This repo is now prepared for the deployment split you are already using:

- `frontend` on Vercel
- `backend` on Render
- `dino-mcp` on Render as a private service
- `postgres` on Render as a managed database

## Files Added

- [render.yaml](d:/fubotics%20chat%20bot/render.yaml)
- [fubotics-chat-frontend/vercel.json](d:/fubotics%20chat%20bot/fubotics-chat-frontend/vercel.json)

## Render Blueprint

The blueprint defines:

- `fubotics-postgres`
- `fubotics-dino-mcp`
- `fubotics-chat-backend`

Important production wiring:

- backend reads `DATABASE_URL` from Render Postgres
- Dino MCP reads `DATABASE_URL` from the same Render Postgres
- backend uses `DINO_MCP_HTTP_URL=http://fubotics-dino-mcp:10000`
- Dino MCP now respects Render's injected `PORT`

## Vercel

Set this environment variable in Vercel:

```env
VITE_API_BASE_URL=https://your-render-backend.onrender.com
```

If you use a custom Render API domain, use that instead.

## Render Environment Variables To Fill In

For `fubotics-chat-backend`:

- `JWT_SECRET`
- `FRONTEND_PUBLIC_URL`
- `BACKEND_PUBLIC_URL`
- `FRONTEND_ORIGINS`
- `GROQ_API_KEY`
- `HUGGINGFACE_API_KEY` or `HF_TOKEN`
- optional image provider keys

For `fubotics-dino-mcp`:

- `GROQ_API_KEY`
- `HUGGINGFACE_API_KEY` or `HF_TOKEN`

## Recommended Values

Backend:

- `FRONTEND_PUBLIC_URL=https://your-vercel-domain.vercel.app`
- `BACKEND_PUBLIC_URL=https://your-render-backend.onrender.com`
- `FRONTEND_ORIGINS=https://your-vercel-domain.vercel.app`

If you also use a custom frontend domain, include both origins:

```env
FRONTEND_ORIGINS=https://your-vercel-domain.vercel.app,https://chat.yourdomain.com
```

## What I Could Prepare Here

I prepared the deployment files and service wiring in the repo.

## What I Could Not Complete From Here

I could not perform the actual Render/Vercel deployment from this session because that requires:

- your Render account access or Render CLI auth
- your Vercel account access or Vercel CLI auth
- permission to create/update those live services

So the repo is deployment-ready, but the final publish step still has to be done with your platform credentials.
