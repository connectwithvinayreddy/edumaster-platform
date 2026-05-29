#!/usr/bin/env bash
set -euo pipefail

echo "JWT_SECRET=$(openssl rand -hex 64)"
echo "PRIVATE_VIDEO_TOKEN_SECRET=$(openssl rand -hex 64)"
echo "LIVE_INGEST_PUBLISHER_SECRET=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
echo "ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')"
echo "REPLAY_IMPORT_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')"
