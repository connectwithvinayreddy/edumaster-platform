#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ENV_FILE="${SOURCE_ENV_FILE:-${ROOT_DIR}/.env.production}"
TEMPLATE_ENV_FILE="${TEMPLATE_ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror.example}"
OUTPUT_ENV_FILE="${OUTPUT_ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
STAGING_IP_VALUE="${1:-${STAGING_IP:-}}"
OVERWRITE_VALUE="${OVERWRITE:-0}"

if [[ -z "${STAGING_IP_VALUE}" ]]; then
  echo "Usage: $0 <staging-ip>" >&2
  echo "Example: $0 203.0.113.10" >&2
  exit 1
fi

if [[ ! -f "${SOURCE_ENV_FILE}" ]]; then
  echo "[staging-env] source env file missing: ${SOURCE_ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_ENV_FILE}" ]]; then
  echo "[staging-env] template env file missing: ${TEMPLATE_ENV_FILE}" >&2
  exit 1
fi

if [[ -f "${OUTPUT_ENV_FILE}" && "${OVERWRITE_VALUE}" != "1" ]]; then
  echo "[staging-env] output already exists: ${OUTPUT_ENV_FILE}" >&2
  echo "[staging-env] set OVERWRITE=1 to replace it" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local file_path="$2"
  grep -E "^${key}=" "${file_path}" | tail -n 1 | cut -d= -f2- || true
}

set_env_value() {
  local key="$1"
  local value="$2"
  python3 - "${OUTPUT_ENV_FILE}" "${key}" "${value}" <<'PY'
from pathlib import Path
import re
import sys

target = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
text = target.read_text()
line = f"{key}={value}"
pattern = re.compile(rf"^{re.escape(key)}=.*$", re.M)
if pattern.search(text):
    updated = pattern.sub(line, text)
else:
    updated = text.rstrip("\n") + "\n\n" + line + "\n"
target.write_text(updated)
PY
}

random_secret() {
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
}

copy_if_present() {
  local key="$1"
  local value
  value="$(read_env_value "${key}" "${SOURCE_ENV_FILE}")"
  if [[ -n "${value}" ]]; then
    set_env_value "${key}" "${value}"
  fi
}

cp "${TEMPLATE_ENV_FILE}" "${OUTPUT_ENV_FILE}"

APP_DOMAIN_VALUE="app.${STAGING_IP_VALUE}.nip.io"
LIVE_DOMAIN_VALUE="live.${STAGING_IP_VALUE}.nip.io"
APP_URL_VALUE="https://${APP_DOMAIN_VALUE}"
LIVE_HLS_VALUE="https://${LIVE_DOMAIN_VALUE}/hls"
LIVE_INGEST_VALUE="rtmp://${LIVE_DOMAIN_VALUE}:1935/live"
POSTGRES_PASSWORD_VALUE="$(random_secret)"
REDIS_PASSWORD_VALUE="$(random_secret)"
JWT_SECRET_VALUE="$(random_secret)"
PRIVATE_VIDEO_TOKEN_SECRET_VALUE="$(random_secret)"
LIVE_INGEST_SECRET_VALUE="$(random_secret)"
ADMIN_PASSWORD_VALUE="$(random_secret)"
REPLAY_IMPORT_PASSWORD_VALUE="$(random_secret)"

set_env_value "SERVICE_NAME" "edumaster-staging-mirror"
set_env_value "COMPOSE_PROJECT_NAME" "edumaster-staging-mirror"
set_env_value "ENVIRONMENT_LABEL" "staging-private-mirror"
set_env_value "APP_URL" "${APP_URL_VALUE}"
set_env_value "APP_DOMAIN" "${APP_DOMAIN_VALUE}"
set_env_value "LIVE_DOMAIN" "${LIVE_DOMAIN_VALUE}"
set_env_value "VITE_PUBLIC_APP_URL" "${APP_URL_VALUE}"
set_env_value "VITE_API_BASE_URL" "${APP_URL_VALUE}/backend/api"
set_env_value "CORS_ORIGIN" "${APP_URL_VALUE},http://localhost,capacitor://localhost,ionic://localhost"

set_env_value "JWT_SECRET" "${JWT_SECRET_VALUE}"
set_env_value "PRIVATE_VIDEO_TOKEN_SECRET" "${PRIVATE_VIDEO_TOKEN_SECRET_VALUE}"
set_env_value "LIVE_INGEST_PUBLISHER_SECRET" "${LIVE_INGEST_SECRET_VALUE}"

set_env_value "ADMIN_NAME" "EduMaster-Staging-Admin"
set_env_value "ADMIN_EMAIL" "staging-admin@edumaster.local"
set_env_value "ADMIN_PASSWORD" "${ADMIN_PASSWORD_VALUE}"
set_env_value "REPLAY_IMPORT_ADMIN_EMAIL" "staging-replay-admin@edumaster.local"
set_env_value "REPLAY_IMPORT_ADMIN_PASSWORD" "${REPLAY_IMPORT_PASSWORD_VALUE}"

set_env_value "POSTGRES_DB" "edumaster"
set_env_value "POSTGRES_USER" "postgres"
set_env_value "POSTGRES_PASSWORD" "${POSTGRES_PASSWORD_VALUE}"
set_env_value "POSTGRES_URL" "postgresql://postgres:${POSTGRES_PASSWORD_VALUE}@postgres:5432/edumaster"
set_env_value "REDIS_PASSWORD" "${REDIS_PASSWORD_VALUE}"
set_env_value "REDIS_URL" "redis://:${REDIS_PASSWORD_VALUE}@redis:6379"
set_env_value "PRIVATE_VIDEO_STORAGE_KEY_PREFIX" "staging-private-mirror/${APP_DOMAIN_VALUE}"
set_env_value "STAGING_ALLOW_SHARED_PROD_STORAGE" "1"

set_env_value "LIVE_HLS_INTERNAL_BASE_URL" "${LIVE_HLS_VALUE}"
set_env_value "LIVE_HLS_PUBLIC_BASE_URL" "${LIVE_HLS_VALUE}"
set_env_value "LIVE_INGEST_STREAM_BASE_URL" "${LIVE_INGEST_VALUE}"
set_env_value "VITE_LIVE_HLS_BASE_URL" "${LIVE_HLS_VALUE}"
set_env_value "VITE_LIVE_INGEST_RTMP_URL" "${LIVE_INGEST_VALUE}"

for key in \
  PRIVATE_VIDEO_STORAGE_PROVIDER \
  VIDEO_HLS_STORAGE_PROVIDER \
  VIDEO_PROCESSING_PROVIDER \
  S3_BUCKET \
  S3_REGION \
  S3_ACCESS_KEY_ID \
  S3_SECRET_ACCESS_KEY \
  S3_ENDPOINT \
  S3_FORCE_PATH_STYLE \
  AI_PROVIDER \
  AI_API_KEY \
  AI_BASE_URL \
  AI_MODEL \
  ENABLE_VIDEO_TRANSCODING \
  SOURCE_PLAYBACK_FALLBACK_ENABLED \
  VIDEO_DELIVERY_PROFILE \
  VIDEO_TARGET_RENDITIONS \
  VIDEO_HLS_SEGMENT_DURATION_SECONDS \
  VIDEO_TRANSCODING_CONCURRENCY \
  VIDEO_TRANSCODING_JOB_TIMEOUT_MS \
  VIDEO_PROCESSING_STALE_AFTER_MS \
  VIDEO_KEEP_SOURCE_AFTER_PROCESSING \
  MAX_VIDEO_UPLOAD_MB \
  VITE_MAX_VIDEO_UPLOAD_MB \
  PRIVATE_VIDEO_TOKEN_TTL_SECONDS \
  PRIVATE_VIDEO_DELIVERY_URL_TTL_SECONDS \
  PRIVATE_VIDEO_HLS_SEGMENT_TOKEN_TTL_SECONDS \
  PRIVATE_VIDEO_HLS_AES_ENCRYPTION_ENABLED \
  PRIVATE_VIDEO_HLS_CACHE_WARM_BASE_URL \
  PRIVATE_VIDEO_DRM_ENABLED \
  PRIVATE_VIDEO_REQUIRE_DRM_FOR_PAID_PLAYBACK \
  COURSE_DEFAULT_VALIDITY_DAYS \
  PRIVATE_VIDEO_NEW_UPLOAD_WATCH_LIMIT \
  PRIVATE_VIDEO_LEGACY_LESSON_WATCH_LIMIT \
  VIDEO_REPLAY_VIEW_LIMIT_ENABLED \
  VIDEO_REPLAY_MAX_VIEWS \
  VIDEO_REPLAY_RETENTION_DAYS \
  RATE_LIMIT_WINDOW_MS \
  RATE_LIMIT_MAX \
  TRUST_PROXY \
  JSON_BODY_LIMIT \
  LOG_LEVEL \
  ALLOW_MEMORY_FALLBACK \
  EXPOSE_SAMPLE_CREDENTIALS \
  CLOUDFLARE_STREAM_CUSTOMER_CODE \
  CLOUDFLARE_STREAM_STATUS_POLL_INITIAL_DELAY_MS \
  VITE_LIVEKIT_URL \
  LIVEKIT_URL \
  LIVEKIT_API_KEY \
  LIVEKIT_API_SECRET \
  LIVEKIT_ROOM_PREFIX \
  LIVEKIT_TOKEN_TTL_SECONDS \
  LIVE_RECORDING_SWEEP_INTERVAL_MS \
  LIVE_CLASS_MAX_ATTENDEES; do
  copy_if_present "${key}"
done

# Keep stream playback-compatible identifiers when needed, but do not carry
# write-capable production Stream credentials into the staging mirror.
set_env_value "CLOUDFLARE_STREAM_ACCOUNT_ID" ""
set_env_value "CLOUDFLARE_STREAM_API_TOKEN" ""
set_env_value "CLOUDFLARE_STREAM_WEBHOOK_SECRET" ""
set_env_value "CLOUDFLARE_STREAM_ALLOWED_ORIGINS" "${APP_URL_VALUE}"

set_env_value "LIVE_CLASSES_ENABLED" "false"
set_env_value "VITE_LIVE_CLASSES_ENABLED" "false"
set_env_value "FIREBASE_STATE_STORAGE" "false"
set_env_value "STAGING_KEEP_LIVE_CLASSES" "false"

cat <<EOF
[staging-env] wrote ${OUTPUT_ENV_FILE}
[staging-env] app url: ${APP_URL_VALUE}
[staging-env] admin email: staging-admin@edumaster.local
[staging-env] admin password: ${ADMIN_PASSWORD_VALUE}
[staging-env] postgres password: ${POSTGRES_PASSWORD_VALUE}
[staging-env] redis password: ${REDIS_PASSWORD_VALUE}
[staging-env] storage prefix: staging-private-mirror/${APP_DOMAIN_VALUE}
[staging-env] shared R2 writer mode is enabled for staging with the prefixed keyspace above
[staging-env] Cloudflare Stream write credentials are intentionally blanked in staging; keep only playback-compatible values like the customer code
[staging-env] review the file before deploy, especially storage and optional live/provider keys
EOF
