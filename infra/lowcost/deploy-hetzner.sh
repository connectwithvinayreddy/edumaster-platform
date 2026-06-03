#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_TARGET="${1:-}"
REMOTE_DIR="${2:-/opt/edumaster}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"

if [[ -z "${REMOTE_TARGET}" ]]; then
  echo "Usage: $0 <user@server> [remote-dir]" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file is missing: ${ENV_FILE}" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

is_placeholder_value() {
  local placeholder_pattern='your-|replace|example\.com|example\.net|placeholder|<[^>]+>'
  [[ "${1:-}" =~ ${placeholder_pattern} ]]
}

shared_prod_storage_allowed() {
  local allow_shared="${STAGING_ALLOW_SHARED_PROD_STORAGE:-$(read_env_value STAGING_ALLOW_SHARED_PROD_STORAGE)}"
  local storage_prefix="${PRIVATE_VIDEO_STORAGE_KEY_PREFIX:-$(read_env_value PRIVATE_VIDEO_STORAGE_KEY_PREFIX)}"

  [[ "${allow_shared}" =~ ^(1|true|yes|on)$ ]] || return 1
  [[ -n "${storage_prefix}" ]] || return 1
  is_placeholder_value "${storage_prefix}" && return 1
  return 0
}

resolve_remote_env_file() {
  if [[ -n "${REMOTE_ENV_FILE:-}" ]]; then
    printf '%s\n' "${REMOTE_ENV_FILE}"
    return
  fi

  if [[ "${ENV_FILE}" == "${ROOT_DIR}/"* ]]; then
    printf '%s\n' "${ENV_FILE#"${ROOT_DIR}/"}"
    return
  fi

  printf '%s\n' "$(basename "${ENV_FILE}")"
}

ENVIRONMENT_LABEL_VALUE="${ENVIRONMENT_LABEL:-$(read_env_value ENVIRONMENT_LABEL)}"
APP_DOMAIN_VALUE="${APP_DOMAIN:-$(read_env_value APP_DOMAIN)}"
PRIVATE_VIDEO_STORAGE_PROVIDER_VALUE="${PRIVATE_VIDEO_STORAGE_PROVIDER:-$(read_env_value PRIVATE_VIDEO_STORAGE_PROVIDER)}"
VIDEO_HLS_STORAGE_PROVIDER_VALUE="${VIDEO_HLS_STORAGE_PROVIDER:-$(read_env_value VIDEO_HLS_STORAGE_PROVIDER)}"
S3_ACCESS_KEY_ID_VALUE="${S3_ACCESS_KEY_ID:-$(read_env_value S3_ACCESS_KEY_ID)}"
S3_SECRET_ACCESS_KEY_VALUE="${S3_SECRET_ACCESS_KEY:-$(read_env_value S3_SECRET_ACCESS_KEY)}"
PROD_APP_DOMAIN_VALUE=""
PROD_S3_ACCESS_KEY_ID_VALUE=""
PROD_S3_SECRET_ACCESS_KEY_VALUE=""
if [[ -f "${ROOT_DIR}/.env.production" ]]; then
  PROD_APP_DOMAIN_VALUE="$(grep -E '^APP_DOMAIN=' "${ROOT_DIR}/.env.production" | tail -n 1 | cut -d= -f2- || true)"
  PROD_S3_ACCESS_KEY_ID_VALUE="$(grep -E '^S3_ACCESS_KEY_ID=' "${ROOT_DIR}/.env.production" | tail -n 1 | cut -d= -f2- || true)"
  PROD_S3_SECRET_ACCESS_KEY_VALUE="$(grep -E '^S3_SECRET_ACCESS_KEY=' "${ROOT_DIR}/.env.production" | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ "${ENVIRONMENT_LABEL_VALUE}" == "staging-private-mirror" ]]; then
  if [[ "${REMOTE_DIR}" == "/opt/edumaster" ]]; then
    echo "[deploy] refusing to deploy staging-private-mirror into the production remote dir /opt/edumaster" >&2
    exit 1
  fi
  if [[ "${APP_DOMAIN_VALUE}" != *.nip.io ]]; then
    echo "[deploy] staging-private-mirror env must use a nip.io app domain. Got: ${APP_DOMAIN_VALUE:-<missing>}" >&2
    exit 1
  fi
  if [[ -n "${PROD_APP_DOMAIN_VALUE}" && "${APP_DOMAIN_VALUE}" == "${PROD_APP_DOMAIN_VALUE}" ]]; then
    echo "[deploy] staging-private-mirror APP_DOMAIN matches production; refusing to continue." >&2
    exit 1
  fi
  if [[ "${PRIVATE_VIDEO_STORAGE_PROVIDER_VALUE}" == "s3" || "${VIDEO_HLS_STORAGE_PROVIDER_VALUE}" == "s3" ]]; then
    if [[ -z "${S3_ACCESS_KEY_ID_VALUE}" || -z "${S3_SECRET_ACCESS_KEY_VALUE}" ]]; then
      echo "[deploy] staging-private-mirror requires working S3 credentials before deploy." >&2
      exit 1
    fi
    if is_placeholder_value "${S3_ACCESS_KEY_ID_VALUE}" || is_placeholder_value "${S3_SECRET_ACCESS_KEY_VALUE}"; then
      echo "[deploy] replace the staging S3 credential placeholders before deploy." >&2
      exit 1
    fi
    if [[ -n "${PROD_S3_ACCESS_KEY_ID_VALUE}" && "${S3_ACCESS_KEY_ID_VALUE}" == "${PROD_S3_ACCESS_KEY_ID_VALUE}" ]]; then
      if ! shared_prod_storage_allowed; then
        echo "[deploy] staging-private-mirror S3_ACCESS_KEY_ID matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely." >&2
        exit 1
      fi
    fi
    if [[ -n "${PROD_S3_SECRET_ACCESS_KEY_VALUE}" && "${S3_SECRET_ACCESS_KEY_VALUE}" == "${PROD_S3_SECRET_ACCESS_KEY_VALUE}" ]]; then
      if ! shared_prod_storage_allowed; then
        echo "[deploy] staging-private-mirror S3_SECRET_ACCESS_KEY matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely." >&2
        exit 1
      fi
    fi
  fi
fi

echo "[deploy] validating env via ${ENV_FILE}"
(cd "${ROOT_DIR}" && ENV_FILE="${ENV_FILE}" npm run validate:production)

echo "[deploy] building frontend locally"
(cd "${ROOT_DIR}" && npm run build)

echo "[deploy] syncing project to ${REMOTE_TARGET}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude "/.env" \
  --exclude "/.env.*" \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "backend/node_modules" \
  --exclude "functions/node_modules" \
  --exclude "functions/backend" \
  --exclude "mobile-rn" \
  --exclude ".venv-play-assets" \
  --exclude "android/app/build" \
  --exclude "android/.gradle" \
  --exclude "ios/App/build" \
  --exclude "dist" \
  --exclude "private_uploads" \
  --exclude "uploads" \
  --exclude "qa-automation" \
  --exclude "tmp-overview-check" \
  --exclude "qa-automation/.dist" \
  "${ROOT_DIR}/" "${REMOTE_TARGET}:${REMOTE_DIR}/"

remote_env_file="$(resolve_remote_env_file)"
if [[ "${remote_env_file}" == /* ]]; then
  remote_env_destination="${remote_env_file}"
else
  remote_env_destination="${REMOTE_DIR}/${remote_env_file}"
fi

echo "[deploy] syncing selected env file to ${REMOTE_TARGET}:${remote_env_destination}"
ssh "${REMOTE_TARGET}" "mkdir -p '$(dirname "${remote_env_destination}")'"
rsync -az "${ENV_FILE}" "${REMOTE_TARGET}:${remote_env_destination}"

echo "[deploy] starting safe rolling deploy on remote host"
ssh "${REMOTE_TARGET}" "chmod +x '${REMOTE_DIR}/infra/lowcost/safe-production-deploy.sh' && cd '${REMOTE_DIR}/infra/lowcost' && ENV_FILE='${remote_env_destination}' ./safe-production-deploy.sh"

echo "[deploy] deployment complete"
