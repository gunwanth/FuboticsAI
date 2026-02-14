# Fubotics Chat Backend

Express backend for Fubotics AI chat with PostgreSQL persistence, per-user session logs, and refresh-token based authentication.

## What this backend now provides

- PostgreSQL storage for users, chat sessions, messages, attachments, auth tokens, and session logs
- Persistent chat/session history across restarts and browser closes
- Rotating refresh tokens stored server-side (token hashes only)
- Session activity audit trail (`login`, `token_refresh`, `logout`, `logout_all`)
- User-isolated chat/session access checks on message and file APIs

## Prerequisites

- Node.js 18+
- PostgreSQL running locally or remotely
- Groq API key (optional for AI responses)

## Setup

1. Install dependencies

```bash
npm install
```

2. Configure env vars (copy from `.env.example`)

```env
PORT=5000
PGHOST=localhost
PGPORT=5432
PGDATABASE=fubotics
PGUSER=postgres
PGPASSWORD=your_postgres_password
JWT_SECRET=replace_with_a_long_random_secret
FRONTEND_ORIGINS=http://localhost:5173
GROQ_API_KEY=your_groq_api_key
```

3. Start server

```bash
npm run dev
```

On startup, schema bootstrap runs automatically from `database/schema.sql`.

## Auth/session behavior

- `POST /api/login` and `POST /api/signup` return `accessToken` and set an `httpOnly` refresh-token cookie.
- `POST /api/refresh` rotates refresh token and returns a fresh `accessToken`.
- `POST /api/logout` revokes the current refresh token and clears cookie.
- `POST /api/logout-all` revokes all refresh tokens for the user.
- `GET /api/session-logs` returns session history and currently active token sessions.

## Core API

- `GET /api/sessions`
- `POST /api/sessions`
- `DELETE /api/sessions/:id`
- `GET /api/messages?sessionId=<id>`
- `POST /api/messages`
- `POST /api/attachments`
- `GET /api/attachments?sessionId=<id>`
- `POST /api/upload-data`
- `GET /api/download-attachment/:id`
