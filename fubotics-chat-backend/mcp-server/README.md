# Dino MCP Server

This MCP server exposes the current Dino tool surface as a standalone Model Context Protocol server.

It now supports two run modes:

- stdio MCP server for MCP-native clients
- HTTP bridge for the main chat backend

## Tools

- `search_rag`
- `deep_search_web`
- `store_knowledge`
- `token_policy_inspect`

## Local Run

From `fubotics-chat-backend/`:

```bash
npm run mcp
```

The server uses stdio transport and speaks JSON-RPC with MCP framing (`Content-Length` headers).

For the HTTP bridge:

```bash
npm run mcp:http
```

## Docker Run

### Recommended: Docker Compose With PostgreSQL

This is the easiest setup for Dino MCP because PostgreSQL and the MCP server share the same Docker network.

1. Create an env file for Compose:

```bash
cp .env.mcp.example .env.mcp
```

2. Fill in at least:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `GROQ_API_KEY` and/or `HF_TOKEN`

3. Start the stack:

```bash
docker compose --env-file .env.mcp -f docker-compose.mcp.yml up --build
```

In this setup:

- PostgreSQL is reachable as `postgres:5432`
- PostgreSQL is exposed on your host as `localhost:5433` by default to avoid colliding with an existing local Postgres on `5432`
- Dino MCP HTTP is exposed on `localhost:5051` by default
- MCP automatically waits for PostgreSQL to become healthy
- no `host.docker.internal` override is needed

To stop it:

```bash
docker compose --env-file .env.mcp -f docker-compose.mcp.yml down
```

To stop it and remove the database volume too:

```bash
docker compose --env-file .env.mcp -f docker-compose.mcp.yml down -v
```

### Direct Docker Run
Build:

```bash
docker build -f mcp-server/Dockerfile -t fubotics-dino-mcp .
```

Run:

```bash
docker run --rm -i \
  --env-file .env \
  fubotics-dino-mcp
```

If PostgreSQL is running on your host machine, `PGHOST=localhost` will fail inside Docker because `localhost`
points to the container itself. Override it when starting the MCP container:

```bash
docker run --rm -i \
  --env-file .env \
  -e PGHOST=host.docker.internal \
  -e PGSSL=false \
  fubotics-dino-mcp
```

If PostgreSQL is running in another container, attach both containers to the same Docker network and set `PGHOST`
to that Postgres container or service name instead.

## Purpose

This lets an external MCP client use Dino's retrieval and learning tools without embedding those tool implementations directly in the client.

It does not itself perform model training.

It enables:

- external agent orchestration
- knowledge base growth
- token-policy inspection
- reusable tool access via MCP

## Backend Integration

The main backend can call the Dockerized Dino server directly over HTTP.

Relevant env vars for `fubotics-chat-backend/.env`:

```bash
DINO_MCP_HTTP_URL=http://127.0.0.1:5051
DINO_MCP_AUTO_WAKE=true
DINO_MCP_COMPOSE_FILE=D:\fubotics chat bot\fubotics-chat-backend\docker-compose.mcp.yml
DINO_MCP_ENV_FILE=D:\fubotics chat bot\fubotics-chat-backend\.env.mcp
```

Behavior:

- backend prefers the HTTP Dino MCP server when available
- if the HTTP server is unavailable, backend falls back to the local spawned MCP child
- if `DINO_MCP_AUTO_WAKE=true`, backend will try to start the Docker Dino stack when it starts or when Dino tools are first used
