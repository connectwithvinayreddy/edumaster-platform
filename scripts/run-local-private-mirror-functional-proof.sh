#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.production}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-3300}"
LOCAL_BASE_URL="${QA_BASE_URL:-http://${LOCAL_HOST}:${LOCAL_PORT}}"
LOCAL_POSTGRES_URL_VALUE="${LOCAL_POSTGRES_URL:-${POSTGRES_URL:-}}"
START_LOCAL_APP_VALUE="${START_LOCAL_APP:-1}"
RUN_WATCH_LIMIT_VALUE="${RUN_WATCH_LIMIT:-1}"
APP_LOG_PATH="${APP_LOG_PATH:-${ROOT_DIR}/reports/local-private-mirror-app.log}"

local_app_pid=""

cleanup() {
  if [[ -n "${local_app_pid}" ]] && kill -0 "${local_app_pid}" 2>/dev/null; then
    kill "${local_app_pid}" 2>/dev/null || true
    wait "${local_app_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_endpoint() {
  local url="$1"
  local timeout_seconds="${2:-180}"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    local status
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" || true)"
    if [[ "${status}" =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi
    sleep 2
  done
  echo "[local-functional-proof] timed out waiting for ${url}" >&2
  return 1
}

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[local-functional-proof] env file missing: ${ENV_FILE_PATH}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE_PATH}"
set +a

export NODE_ENV=development
export HOST="${LOCAL_HOST}"
export PORT="${LOCAL_PORT}"
export APP_URL="${LOCAL_BASE_URL}"
export VITE_PUBLIC_APP_URL="${LOCAL_BASE_URL}"
export VITE_API_BASE_URL="${LOCAL_BASE_URL}/backend/api"
export CORS_ORIGIN="${LOCAL_BASE_URL},http://localhost,capacitor://localhost,ionic://localhost"
if [[ -n "${LOCAL_POSTGRES_URL_VALUE}" ]]; then
  export POSTGRES_URL="${LOCAL_POSTGRES_URL_VALUE}"
fi

if ! curl -f -sS -o /dev/null --max-time 5 "${LOCAL_BASE_URL}/backend/api/health"; then
  if [[ "${START_LOCAL_APP_VALUE}" != "1" ]]; then
    echo "[local-functional-proof] ${LOCAL_BASE_URL} is not up and START_LOCAL_APP=1 was not provided." >&2
    exit 1
  fi

  mkdir -p "$(dirname "${APP_LOG_PATH}")"
  (
    cd "${ROOT_DIR}"
    npm run dev:app
  ) > "${APP_LOG_PATH}" 2>&1 &
  local_app_pid=$!
fi

wait_for_endpoint "${LOCAL_BASE_URL}/backend/api/health" 180
wait_for_endpoint "${LOCAL_BASE_URL}/backend/api/ready" 180

ENV_FILE="${ENV_FILE_PATH}" \
QA_BASE_URL="${LOCAL_BASE_URL}" \
RUN_WATCH_LIMIT="${RUN_WATCH_LIMIT_VALUE}" \
PROOF_SCOPE="localhost" \
bash "${ROOT_DIR}/scripts/run-targeted-functional-proof.sh"
