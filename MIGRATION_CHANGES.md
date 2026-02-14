# Migration and Fix Notes

## Scope
This note records the SQLite -> PostgreSQL migration hardening work, auth/session fixes, and verification steps completed in this workspace.

## What Was Changed

### Backend architecture and persistence
- Added PostgreSQL config/pool layer:
  - `fubotics-chat-backend/config/database.js`
  - `fubotics-chat-backend/db/index.js`
- Added normalized schema for users, chat sessions, messages, attachments, refresh tokens, and session logs:
  - `fubotics-chat-backend/database/schema.sql`

### Authentication and session lifecycle
- Implemented/updated controller flow for:
  - signup/login
  - refresh token rotation
  - logout/logout-all
  - session log retrieval
- File:
  - `fubotics-chat-backend/controllers/authController.js`
- Added middleware:
  - `fubotics-chat-backend/middleware/auth.js`
- Added token/session models:
  - `fubotics-chat-backend/models/authToken.js`
  - `fubotics-chat-backend/models/sessionLog.js`

### Chat/session isolation and data access
- Added/updated models:
  - `fubotics-chat-backend/models/user.js`
  - `fubotics-chat-backend/models/chatSession.js`
  - `fubotics-chat-backend/models/message.js`
  - `fubotics-chat-backend/models/attachment.js`
- Updated route ownership checks in:
  - `fubotics-chat-backend/index.js`

### Frontend token persistence flow
- Updated auth token handling and refresh bootstrap:
  - `fubotics-chat-frontend/src/App.jsx`

### Documentation and env updates
- Updated:
  - `fubotics-chat-backend/README.md`
  - `fubotics-chat-backend/.env`
  - `fubotics-chat-backend/.env.example`

## Key Issues Fixed
- `schema.sql` rerun noise and migration fragility reduced by making schema idempotent and cleaner.
- Runtime auth bug fixed: `this.generateAccessToken is not a function` in controller handlers.
- Refresh-token flow hardened with rotation and DB-backed token/session metadata.
- Session ownership checks tightened for message/session routes.
- Session delete cleanup fixed by using an attachment file-path specific query method.
- Backend startup blockers resolved by installing missing dependencies.

## Commands Used and Their Purpose

### Repo and file inspection
```bash
git status --short
```
Use: Show changed/untracked files quickly.

```bash
git diff --name-only
```
Use: List tracked files with modifications.

```bash
rg --files
```
Use: Fast recursive file listing for project discovery.

```bash
rg -n "pattern" <paths>
```
Use: Locate specific code references and potential breakpoints.

### Runtime validation (Node)
```bash
node --check index.js
node --check controllers/authController.js
node --check models/authToken.js
node --check models/message.js
node --check models/attachment.js
```
Use: Syntax-check JS files without running the full app.

```bash
node index.js
```
Use: Start backend and validate boot path.

```bash
npm install
```
Use: Install backend dependencies required for runtime.

### PostgreSQL validation (psql)
```bash
"C:\Program Files\PostgreSQL\15\bin\psql.exe" --version
```
Use: Confirm `psql` binary path/version.

```bash
$env:PGPASSWORD='***'; psql -h localhost -p 5432 -U postgres -d postgres -c "\\l"
```
Use: List databases and confirm server connectivity.

```bash
$env:PGPASSWORD='***'; psql -h localhost -p 5432 -U postgres -d postgres -c "CREATE DATABASE fubotics;"
```
Use: Create target application DB.

```bash
$env:PGPASSWORD='***'; psql -h localhost -p 5432 -U postgres -d fubotics -v ON_ERROR_STOP=1 -f database/schema.sql
```
Use: Apply schema file and fail fast on SQL errors.

```bash
$env:PGPASSWORD='***'; psql -h localhost -p 5432 -U postgres -d fubotics -c "\\dt" -c "\\dv"
```
Use: Verify tables/views created.

### API smoke testing
```bash
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/signup ...
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/refresh ...
Invoke-RestMethod -Method Get  -Uri http://localhost:5000/api/session-logs ...
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/logout ...
```
Use: Validate auth/session lifecycle end-to-end.

## Notes
- There is a stray file: `fubotics-chat-backend/config/database.js files.`. It should be removed or renamed to avoid tooling noise.
- Generated artifacts under `fubotics-chat-backend/generated/` came from runtime tests.

## Suggested next cleanup
1. Remove stray config file: `config/database.js files.`
2. Keep test-generated files out of source control.
3. Rotate exposed API secrets and keep `.env` out of commits.
