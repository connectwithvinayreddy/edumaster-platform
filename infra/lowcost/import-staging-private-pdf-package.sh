#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/lowcost/docker-compose.prod.yml"
PACKAGE_DIR="${1:-}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
STACK_ENV_FILE_PATH="${STACK_ENV_FILE_PATH:-${ENV_FILE}}"

if [[ -z "${PACKAGE_DIR}" || ! -d "${PACKAGE_DIR}" ]]; then
  echo "Usage: ENV_FILE=.env.staging.private-mirror $0 /absolute/path/to/targeted-pdf-package-dir" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[staging-pdf-import] env file missing: ${ENV_FILE}" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

COMPOSE_PROJECT_NAME_VALUE="$(read_env_value COMPOSE_PROJECT_NAME)"
if [[ -z "${COMPOSE_PROJECT_NAME_VALUE}" ]]; then
  COMPOSE_PROJECT_NAME_VALUE="$(read_env_value SERVICE_NAME)"
fi
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-edumaster-staging-mirror}"

export STACK_ENV_FILE_PATH

compose() {
  docker compose \
    -p "${COMPOSE_PROJECT_NAME_VALUE}" \
    --env-file "${ENV_FILE}" \
    -f "${COMPOSE_FILE}" \
    "$@"
}

compose up -d app >/dev/null
app_container_id="$(compose ps -q app)"
if [[ -z "${app_container_id}" ]]; then
  echo "[staging-pdf-import] failed to resolve the running app container." >&2
  exit 1
fi

docker exec "${app_container_id}" sh -lc "rm -rf /tmp/targeted-course-pdfs-package && mkdir -p /tmp/targeted-course-pdfs-package"
docker cp "${PACKAGE_DIR}/." "${app_container_id}:/tmp/targeted-course-pdfs-package/"
docker exec "${app_container_id}" sh -lc "cd /app && TARGET_PDF_PACKAGE_DIR=/tmp/targeted-course-pdfs-package TARGET_PRIVATE_UPLOADS_ROOT=/app/private_uploads node backend/scripts/import-targeted-course-pdfs.mjs"
docker exec "${app_container_id}" sh -lc "rm -rf /tmp/targeted-course-pdfs-package"
