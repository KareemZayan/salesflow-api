#!/bin/sh
# Startup flow (CLAUDE.md section 10): wait for DB -> migrate -> seed -> start app.
# Kept out of app code on purpose so the API process only serves traffic.
set -eu

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"

echo "[entrypoint] Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
attempts=0
until node -e "require('net').connect({host:process.argv[1],port:+process.argv[2]}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" "$DB_HOST" "$DB_PORT"; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "[entrypoint] PostgreSQL not reachable after ${attempts} attempts" >&2
    exit 1
  fi
  sleep 2
done

# Phase 4 enables these once Prisma exists:
# echo "[entrypoint] Running migrations..."
# pnpm prisma migrate deploy
# echo "[entrypoint] Seeding (idempotent)..."
# pnpm db:seed

echo "[entrypoint] Starting: $*"
exec "$@"
