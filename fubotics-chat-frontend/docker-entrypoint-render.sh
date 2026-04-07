#!/bin/sh
set -eu

export PORT="${PORT:-80}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://localhost:5001}"

envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
envsubst '${VITE_API_BASE_URL}' < /usr/share/nginx/html/env-config.template.js > /usr/share/nginx/html/env-config.js
