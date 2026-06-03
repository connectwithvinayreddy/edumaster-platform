#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_SSH_TARGET="${1:-}"
STAGING_IP_VALUE="${2:-${STAGING_IP:-}}"
STAGING_REMOTE_DIR="${3:-${STAGING_REMOTE_DIR:-/opt/edumaster-staging}}"
PROD_SSH_TARGET="${PROD_SSH_TARGET:-root@178.105.48.179}"
ENV_FILE_PATH="${ENV_FILE_PATH:-${ROOT_DIR}/.env.staging.private-mirror}"
REMOTE_ENV_FILE_PATH="${REMOTE_ENV_FILE_PATH:-${STAGING_REMOTE_DIR}/$(basename "${ENV_FILE_PATH}")}"
STAGING_BACKUP_PATH="${STAGING_BACKUP_PATH:-${STAGING_REMOTE_DIR}/backups/postgres.sql.gz}"
BOOTSTRAP_STAGING_HOST_VALUE="${BOOTSTRAP_STAGING_HOST:-0}"
OVERWRITE_STAGING_ENV_VALUE="${OVERWRITE_STAGING_ENV:-0}"
RUN_HEALTH_CHECK_VALUE="${RUN_HEALTH_CHECK:-1}"
RUN_BROWSER_GATE_VALUE="${RUN_BROWSER_GATE:-0}"
CONFIGURE_R2_CORS_VALUE="${CONFIGURE_R2_CORS:-1}"
REQUIRE_R2_CORS_CONFIG_VALUE="${REQUIRE_R2_CORS_CONFIG:-0}"

if [[ -z "${STAGING_SSH_TARGET}" || -z "${STAGING_IP_VALUE}" ]]; then
  echo "Usage: $0 <user@staging-host> <staging-ip> [remote-dir]" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local file_path="$2"
  grep -E "^${key}=" "${file_path}" | tail -n 1 | cut -d= -f2- || true
}

is_placeholder_value() {
  local placeholder_pattern='your-|replace|example\.com|example\.net|placeholder|<[^>]+>'
  [[ "${1:-}" =~ ${placeholder_pattern} ]]
}

shared_prod_storage_allowed() {
  local allow_shared
  local storage_prefix

  allow_shared="$(read_env_value STAGING_ALLOW_SHARED_PROD_STORAGE "${ENV_FILE_PATH}")"
  storage_prefix="$(read_env_value PRIVATE_VIDEO_STORAGE_KEY_PREFIX "${ENV_FILE_PATH}")"

  [[ "${allow_shared}" =~ ^(1|true|yes|on)$ ]] || return 1
  [[ -n "${storage_prefix}" ]] || return 1
  is_placeholder_value "${storage_prefix}" && return 1
  return 0
}

extract_ssh_host() {
  printf '%s\n' "${1#*@}"
}

assert_staging_storage_credentials() {
  local private_provider
  local hls_provider
  local staging_access_key
  local staging_secret_key
  local prod_env_file="${ROOT_DIR}/.env.production"
  local prod_access_key=""
  local prod_secret_key=""

  private_provider="$(read_env_value PRIVATE_VIDEO_STORAGE_PROVIDER "${ENV_FILE_PATH}")"
  hls_provider="$(read_env_value VIDEO_HLS_STORAGE_PROVIDER "${ENV_FILE_PATH}")"

  if [[ "${private_provider}" != "s3" && "${hls_provider}" != "s3" ]]; then
    return
  fi

  staging_access_key="$(read_env_value S3_ACCESS_KEY_ID "${ENV_FILE_PATH}")"
  staging_secret_key="$(read_env_value S3_SECRET_ACCESS_KEY "${ENV_FILE_PATH}")"

  if [[ -z "${staging_access_key}" || -z "${staging_secret_key}" ]]; then
    echo "[staging-deploy] set working S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in ${ENV_FILE_PATH} before deploy" >&2
    exit 1
  fi

  if is_placeholder_value "${staging_access_key}" || is_placeholder_value "${staging_secret_key}"; then
    echo "[staging-deploy] replace the S3 credential placeholders in ${ENV_FILE_PATH} before deploy" >&2
    exit 1
  fi

  if [[ -f "${prod_env_file}" ]]; then
    prod_access_key="$(read_env_value S3_ACCESS_KEY_ID "${prod_env_file}")"
    prod_secret_key="$(read_env_value S3_SECRET_ACCESS_KEY "${prod_env_file}")"
    if [[ -n "${prod_access_key}" && "${staging_access_key}" == "${prod_access_key}" ]]; then
      if ! shared_prod_storage_allowed; then
        echo "[staging-deploy] staging S3_ACCESS_KEY_ID matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely" >&2
        exit 1
      fi
    fi
    if [[ -n "${prod_secret_key}" && "${staging_secret_key}" == "${prod_secret_key}" ]]; then
      if ! shared_prod_storage_allowed; then
        echo "[staging-deploy] staging S3_SECRET_ACCESS_KEY matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely" >&2
        exit 1
      fi
    fi
  fi
}

assert_staging_stream_credentials() {
  local video_provider
  local staging_api_token
  local staging_account_id
  local prod_env_file="${ROOT_DIR}/.env.production"
  local prod_api_token=""
  local prod_account_id=""

  video_provider="$(read_env_value VIDEO_PROCESSING_PROVIDER "${ENV_FILE_PATH}")"
  if [[ "${video_provider}" != "cloudflare-stream" ]]; then
    return
  fi

  staging_api_token="$(read_env_value CLOUDFLARE_STREAM_API_TOKEN "${ENV_FILE_PATH}")"
  staging_account_id="$(read_env_value CLOUDFLARE_STREAM_ACCOUNT_ID "${ENV_FILE_PATH}")"

  if [[ -z "${staging_api_token}" || -z "${staging_account_id}" ]]; then
    echo "[staging-deploy] VIDEO_PROCESSING_PROVIDER=cloudflare-stream requires staging-only CLOUDFLARE_STREAM_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN" >&2
    exit 1
  fi

  if is_placeholder_value "${staging_api_token}" || is_placeholder_value "${staging_account_id}"; then
    echo "[staging-deploy] replace placeholder Cloudflare Stream credentials in ${ENV_FILE_PATH} before deploy" >&2
    exit 1
  fi

  if [[ -f "${prod_env_file}" ]]; then
    prod_api_token="$(read_env_value CLOUDFLARE_STREAM_API_TOKEN "${prod_env_file}")"
    prod_account_id="$(read_env_value CLOUDFLARE_STREAM_ACCOUNT_ID "${prod_env_file}")"
    if [[ -n "${prod_api_token}" && "${staging_api_token}" == "${prod_api_token}" ]]; then
      echo "[staging-deploy] staging CLOUDFLARE_STREAM_API_TOKEN matches production; use a staging-only token instead" >&2
      exit 1
    fi
    if [[ -n "${prod_account_id}" && "${staging_account_id}" == "${prod_account_id}" ]]; then
      echo "[staging-deploy] staging CLOUDFLARE_STREAM_ACCOUNT_ID matches production while using cloudflare-stream provider; use isolated staging credentials instead" >&2
      exit 1
    fi
  fi
}

prod_host="$(extract_ssh_host "${PROD_SSH_TARGET}")"
staging_host="$(extract_ssh_host "${STAGING_SSH_TARGET}")"

if [[ "${staging_host}" == "${prod_host}" || "${STAGING_IP_VALUE}" == "${prod_host}" ]]; then
  echo "[staging-deploy] refusing to use the production host as staging: ${staging_host}" >&2
  exit 1
fi

if [[ "${BOOTSTRAP_STAGING_HOST_VALUE}" == "1" ]]; then
  bash "${ROOT_DIR}/scripts/bootstrap-separate-staging-vps.sh" "${STAGING_SSH_TARGET}" "${STAGING_REMOTE_DIR}"
fi

if [[ ! -f "${ENV_FILE_PATH}" || "${OVERWRITE_STAGING_ENV_VALUE}" == "1" ]]; then
  OUTPUT_ENV_FILE="${ENV_FILE_PATH}" OVERWRITE="${OVERWRITE_STAGING_ENV_VALUE}" \
    bash "${ROOT_DIR}/scripts/create-staging-private-mirror-env.sh" "${STAGING_IP_VALUE}"
fi

assert_staging_storage_credentials
assert_staging_stream_credentials

if [[ "${CONFIGURE_R2_CORS_VALUE}" == "1" ]]; then
  echo "[staging-deploy] configuring R2 bucket CORS for the staging app origin"
  if ! (cd "${ROOT_DIR}" && ENV_FILE="${ENV_FILE_PATH}" node backend/scripts/configure-r2-bucket-cors.mjs); then
    if [[ "${REQUIRE_R2_CORS_CONFIG_VALUE}" == "1" ]]; then
      echo "[staging-deploy] R2 bucket CORS configuration failed and REQUIRE_R2_CORS_CONFIG=1 is set" >&2
      exit 1
    fi
    echo "[staging-deploy] warning: R2 bucket CORS configuration failed; continuing with deploy" >&2
  fi
fi

ENV_FILE="${ENV_FILE_PATH}" bash "${ROOT_DIR}/infra/lowcost/deploy-hetzner.sh" "${STAGING_SSH_TARGET}" "${STAGING_REMOTE_DIR}"

REMOTE_BACKUP_PATH="$(bash "${ROOT_DIR}/scripts/export-production-postgres-backup.sh" "${PROD_SSH_TARGET}")"
echo "[staging-deploy] production backup created: ${REMOTE_BACKUP_PATH}"

ssh "${STAGING_SSH_TARGET}" "mkdir -p '$(dirname "${STAGING_BACKUP_PATH}")'"
ssh "${PROD_SSH_TARGET}" "cat '${REMOTE_BACKUP_PATH}'" | ssh "${STAGING_SSH_TARGET}" "cat > '${STAGING_BACKUP_PATH}'"
ssh "${STAGING_SSH_TARGET}" "test -s '${STAGING_BACKUP_PATH}'"

ssh "${STAGING_SSH_TARGET}" "\
  cd '${STAGING_REMOTE_DIR}' && \
  ENV_FILE='${REMOTE_ENV_FILE_PATH}' \
  bash ./infra/lowcost/restore-staging-private-mirror.sh '${STAGING_BACKUP_PATH}'"

STAGING_BASE_URL="https://app.${STAGING_IP_VALUE}.nip.io"

if [[ "${RUN_HEALTH_CHECK_VALUE}" == "1" ]]; then
  bash "${ROOT_DIR}/scripts/check-staging-private-mirror-health.sh" "${STAGING_BASE_URL}"
fi

cat <<EOF
[staging-deploy] staging mirror is prepared.
[staging-deploy] base url: ${STAGING_BASE_URL}
[staging-deploy] next browser gate:
ENV_FILE=${ENV_FILE_PATH} \\
QA_BASE_URL=${STAGING_BASE_URL} \\
bash ./scripts/run-staging-private-mirror-gate.sh
EOF

if [[ "${RUN_BROWSER_GATE_VALUE}" == "1" ]]; then
  ENV_FILE="${ENV_FILE_PATH}" QA_BASE_URL="${STAGING_BASE_URL}" \
    bash "${ROOT_DIR}/scripts/run-staging-private-mirror-gate.sh"
fi
