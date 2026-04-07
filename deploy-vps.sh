#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/.env.production"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available" >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo ".env.production not found. Copy .env.production.example first." >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "Pulling base images where available..."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull || true

echo "Building and starting the stack..."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --build --remove-orphans

echo "Current status:"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps

echo
echo "Follow logs with:"
echo "docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} logs -f"
