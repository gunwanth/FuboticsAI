# Fubotics AI Engineering Runbook (Explained)

## 1. Purpose of This Document
This file explains the major engineering work done in the project so far, not just as a changelog, but as a practical handover guide.

It covers:
- what was changed
- why it was changed
- how it works today
- where to find the implementation
- how to test and troubleshoot

---

## 2. High-Level Architecture

The system is split into two applications:

1. `fubotics-chat-backend` (Node.js + Express + PostgreSQL)
- Handles auth, sessions, messages, attachments, AI integration, and sharing.

2. `fubotics-chat-frontend` (React + Vite + Axios)
- Handles UI, token refresh flow, session/chat rendering, and calling backend routes.

The key architectural shift was from SQLite-style local persistence to PostgreSQL-backed persistence for reliable multi-session and production hosting behavior.

---

## 3. Why PostgreSQL Migration Was Needed

Main problems before migration:
- session persistence issues
- weak concurrency handling
- scaling limitations
- poor indexing for message/session-heavy workloads
- hard-to-track login session lifecycle

What PostgreSQL solved:
- durable session and token storage
- better concurrent access behavior
- explicit indexing strategy
- easier production deployment with hosted DBs
- schema-level constraints for data integrity

Main files:
- `fubotics-chat-backend/config/database.js`
- `fubotics-chat-backend/db/index.js`
- `fubotics-chat-backend/database/schema.sql`

---

## 4. Database Schema (Explained)

Schema file:
- `fubotics-chat-backend/database/schema.sql`

### Core tables

1. `users`
- Stores app users.
- `username` unique, password stored as hash.

2. `auth_tokens`
- Stores refresh token records and lifecycle metadata.
- Includes rotation fields (`rotated_from_id`, `replaced_by_token_id`) and revocation state.
- Enables secure refresh-token strategy instead of stateless-only auth.

3. `session_logs`
- Stores login/logout/session events per user.
- Helps trace session activity and support audit/debug workflows.

4. `chat_sessions`
- One user can have multiple chat sessions.
- Supports naming and update timestamps.

5. `messages`
- Stores chat content by session and role (`user`, `assistant`, `system`).

6. `attachments`
- Stores uploaded/generated file metadata and analysis output.

7. `message_attachments`
- Many-to-many link between messages and attachments.

8. `shared_chats`
- Stores share token for public read/share workflows.

### Performance and integrity features
- indexes on token/session/message access paths
- trigger to keep `updated_at` current
- view `user_session_summary` for quick user/session insights

---

## 5. Backend Models and Their Role

Located under `fubotics-chat-backend/models`.

1. `user.js`
- user create/lookup functions.

2. `authToken.js`
- refresh-token creation, lookup, rotation, revocation support.

3. `sessionLog.js`
- session event logging.

4. `chatSession.js`
- create/read/update/delete user chat sessions.

5. `message.js`
- message read/write and edit/regenerate related methods.

6. `attachment.js`
- attachment save, retrieval, and linking behavior.

7. `shareChat.js`
- create/get share tokens for session sharing.

---

## 6. Authentication and Session Security Pipeline

### Objective
Keep users logged in securely while allowing short-lived access tokens and durable refresh sessions.

### Flow
1. User login/signup creates:
- short-lived access token (for API calls)
- refresh token in secure cookie (for renewal)

2. Frontend request interceptor attaches `Authorization` token.

3. On access token expiry (`401 TOKEN_EXPIRED`):
- Axios response interceptor triggers `/api/refresh`
- refresh queue avoids duplicate refresh calls
- pending requests are retried after new access token arrives

4. Logout/logout-all revokes tokens and updates logs.

Main files:
- `fubotics-chat-backend/controllers/authController.js`
- `fubotics-chat-backend/middleware/auth.js`
- `fubotics-chat-frontend/src/App.jsx`

---

## 7. Route Inventory with Intent

Backend routes in `fubotics-chat-backend/index.js`.

### Health/Auth
- `GET /api/health`: service check.
- `POST /api/signup`, `POST /api/login`: auth entry.
- `POST /api/refresh`: token rotation endpoint.
- `POST /api/logout`, `POST /api/logout-all`: session termination.
- `GET /api/me`: current user identity.
- `GET /api/session-logs`: per-user session event history.

### Sessions and messages
- `GET /api/sessions`: list user sessions.
- `POST /api/sessions`: create session.
- `POST /api/sessions/auto`: create + AI-suggested name from first prompt.
- `PUT /api/sessions/:id`: rename session.
- `DELETE /api/sessions/:id`: delete session with ownership checks.
- `GET /api/messages`: fetch session messages.
- `POST /api/messages`: send message / trigger generation pipeline.
- `PUT /api/messages/:id`: edit message and regenerate downstream response.

### Share/public flows
- `POST /api/sessions/:id/share`: create share token URL.
- `GET /api/public/share/:token`: load shared chat snapshot.
- `POST /api/public/share/:token/chat`: anonymous interaction on shared chat.
- `POST /api/public/share/:token/continue`: continue shared history into logged account.
- `POST /api/public/chat`: anonymous base-chat route (homepage use).

### Deep search and file workflows
- `POST /api/deep-search`: search/source pipeline.
- `POST /api/generate`: generation requests.
- `POST /api/attachments`: upload files.
- `GET /api/attachments`: list session files.
- `POST /api/upload-data`: CSV/data upload pipeline.
- `GET /api/download/:filename`: generated file download.
- `GET /api/download-attachment/:id`: attachment download.

---

## 8. AI and Content Pipelines (How They Work)

### A. Standard chat response
1. Save user message.
2. Build conversation history context.
3. Optionally add deep-search sources/cross-chat context.
4. Generate assistant response.
5. Save assistant message.

### B. Content generation route inside message pipeline
If prompt intent is detected (`image`, `pdf`, `ppt`, `notes`, `document`):
1. run generation helper
2. create file
3. save file metadata in `attachments`
4. link file to assistant message

### C. File extraction pipeline
Upload file -> type detection -> extraction:
- CSV (`csv-parser`)
- PDF (`pdf-parse`)
- DOCX (`mammoth`)
- XLS/XLSX (`xlsx`)
Then extraction summary is saved and reused in context.

### D. Share and anonymous chat logic
- shared token chats can be viewed without login
- anonymous users can ask questions in shared chat
- continue action migrates history into a real user session after login
- homepage now supports anonymous chat using `/api/public/chat`

---

## 9. Frontend Async and Axios Design (Explained)

Main file:
- `fubotics-chat-frontend/src/App.jsx`

### Key behavior
1. App bootstraps token from local storage or refresh endpoint.
2. Axios interceptors handle token attach/refresh/retry.
3. UI supports three chat contexts:
- authenticated account chat
- shared-link anonymous chat
- homepage anonymous chat

### Important async handlers
- `handleSend()`: routes message by context (auth/share/anonymous).
- `continueSharedChatWithCurrentAuth()`: carries share history into account.
- `handleFileAttachment()` / `handleFileUpload()`: upload pipelines.
- `handleDownload...()`: file retrieval.

### Anonymous gating logic
- soft prompt at 10 questions
- hard lock at 15 questions
- login/signup modal for continuation
- premium features disabled until login

---

## 10. UI/Interaction Updates

Implemented changes include:
- session 3-dot menu behavior (share, rename, delete)
- centered confirmation modal behavior
- share link handling with anonymous-first flow
- continue-chat button placement in share mode
- lock modal and auth modal interaction fixes

Known recent bug fix:
- hard lock popup now closes correctly when login/signup is clicked and on auth success.

---

## 11. Testing Phases and Commands

### Phase 1: DB and schema validation
```powershell
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" --version
$env:PGPASSWORD="***"; psql -h localhost -p 5432 -U postgres -d fubotics -v ON_ERROR_STOP=1 -f fubotics-chat-backend/database/schema.sql
$env:PGPASSWORD="***"; psql -h localhost -p 5432 -U postgres -d fubotics -c "\dt" -c "\dv"
```

### Phase 2: Backend checks
```powershell
node --check fubotics-chat-backend/index.js
node --check fubotics-chat-backend/controllers/authController.js
node fubotics-chat-backend/index.js
```

### Phase 3: Frontend build and behavior
```powershell
npm --prefix "d:\fubotics chat bot\fubotics-chat-frontend" run build
```

### Phase 4: Git workflow
```powershell
git status --short --branch
git diff --name-only
git add <files>
git commit -m "<message>"
git push origin main
```

---

## 12. Error Detection and Troubleshooting Map

### 1) `Failed to initialize database schema`
Typical causes:
- missing/invalid `DATABASE_URL`
- SSL mismatch (`PGSSL`)
- DB unreachable or wrong credentials
Action:
- validate env values and run schema manually with `psql`.

### 2) `500` from `/api/messages`
Typical causes:
- provider config gaps for generation
- invalid request payload/state
Action:
- inspect backend logs for route-specific error details.

### 3) Image generation provider failures
Observed categories:
- deprecated endpoint usage
- insufficient token permissions
- provider-specific 400/403 behaviors
Action:
- verify provider endpoint, key permissions, and fallback path.

### 4) Shared link opening login unexpectedly
Cause:
- frontend gating condition too strict.
Fix:
- explicit anonymous mode routing on shared and base URL contexts.

### 5) Hard lock modal not closing
Cause:
- modal state not cleared during auth action.
Fix:
- clear lock modal state on `openAuthFor()` and auth success path.

---

## 13. Environment Variables (Operational Notes)

Template:
- `fubotics-chat-backend/.env.example`

Minimum required:
- DB: `DATABASE_URL` (or PG host-based vars)
- auth: `JWT_SECRET`
- model: `GROQ_API_KEY`
- CORS/public URLs: `FRONTEND_ORIGINS`, `FRONTEND_PUBLIC_URL`

Optional:
- image/content provider variables
- deep search and token-budget tunables

Security guidance:
- never commit real secrets in repo
- keep production values in provider secret manager (Render/Vercel dashboard)

---

## 14. Automation Summary

Implemented automations:
- token auto-refresh and queued request replay
- auto session naming from first prompt
- DB trigger for timestamp maintenance
- file extraction by format
- generated file linking into chat responses
- anonymous usage gating with modal escalation

---

## 15. Most Important Files to Review First
- `fubotics-chat-backend/index.js`
- `fubotics-chat-backend/database/schema.sql`
- `fubotics-chat-backend/controllers/authController.js`
- `fubotics-chat-backend/models/authToken.js`
- `fubotics-chat-backend/models/message.js`
- `fubotics-chat-backend/models/attachment.js`
- `fubotics-chat-frontend/src/App.jsx`
- `fubotics-chat-frontend/src/App.css`

---

## 16. Suggested Next Maintenance Improvements
1. Add automated API tests for auth/share/anonymous flows.
2. Add DB migrations framework (versioned migration scripts).
3. Add centralized structured logging for production incidents.
4. Add rate limits for public anonymous routes.
5. Add monitoring dashboards for error rate and route latency.

