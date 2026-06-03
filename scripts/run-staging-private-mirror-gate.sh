#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
QA_BASE_URL_VALUE="${QA_BASE_URL:-}"
DEFAULT_TARGETS_FILE="${ROOT_DIR}/qa-automation/stream-cert-targets.example.json"
if [[ ! -f "${DEFAULT_TARGETS_FILE}" ]]; then
  DEFAULT_TARGETS_FILE="${ROOT_DIR}/qa-automation/stream-cert-targets.video-only.runtime.json"
fi
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${DEFAULT_TARGETS_FILE}}"
QA_STREAM_CERT_TARGET_KEY_VALUE="${QA_STREAM_CERT_TARGET_KEY:-}"
QA_STREAM_CERT_TARGET_INDEX_VALUE="${QA_STREAM_CERT_TARGET_INDEX:-}"
QA_VIDEO_BROWSER_STAGES_VALUE="${QA_VIDEO_BROWSER_STAGES:-1,3,10,15,25,50}"
HEALTH_CHECK_REPEATS="${HEALTH_CHECK_REPEATS:-3}"
RUN_WATCH_LIMIT_VALUE="${RUN_WATCH_LIMIT:-0}"
RUN_HYBRID_3K_VALUE="${RUN_HYBRID_3K:-0}"
RUN_HYBRID_4K_VALUE="${RUN_HYBRID_4K:-0}"
HYBRID_3K_BROWSER_USERS="${HYBRID_3K_BROWSER_USERS:-50}"
HYBRID_3K_DIAGNOSTIC_USERS="${HYBRID_3K_DIAGNOSTIC_USERS:-2950}"
HYBRID_4K_BROWSER_USERS="${HYBRID_4K_BROWSER_USERS:-100}"
HYBRID_4K_DIAGNOSTIC_USERS="${HYBRID_4K_DIAGNOSTIC_USERS:-3900}"
HYBRID_PLATFORM_SETUP_CONCURRENCY="${HYBRID_PLATFORM_SETUP_CONCURRENCY:-50}"
HYBRID_PLATFORM_ACTIVE_CONCURRENCY="${HYBRID_PLATFORM_ACTIVE_CONCURRENCY:-}"
PLATFORM_LOAD_USERS_FILE_VALUE="${PLATFORM_LOAD_USERS_FILE:-}"
COURSE_LOAD_USERS_FILE_VALUE="${COURSE_LOAD_USERS_FILE:-}"
QA_COURSE_ID_VALUE="${QA_COURSE_ID:-}"
QA_LESSON_ID_VALUE="${QA_LESSON_ID:-}"
QA_COURSE_TEXT_VALUE="${QA_COURSE_TEXT:-}"
QA_LESSON_TEXT_VALUE="${QA_LESSON_TEXT:-}"
QA_WATCH_LIMIT_COURSE_ID_VALUE="${QA_WATCH_LIMIT_COURSE_ID:-${QA_COURSE_ID_VALUE}}"
QA_WATCH_LIMIT_LESSON_ID_VALUE="${QA_WATCH_LIMIT_LESSON_ID:-${QA_LESSON_ID_VALUE}}"
QA_WATCH_LIMIT_COURSE_TEXT_VALUE="${QA_WATCH_LIMIT_COURSE_TEXT:-${QA_COURSE_TEXT_VALUE}}"
QA_WATCH_LIMIT_LESSON_TEXT_VALUE="${QA_WATCH_LIMIT_LESSON_TEXT:-${QA_LESSON_TEXT_VALUE}}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/staging-private-mirror-gate-${RUN_ID}"
BROWSER_MANIFEST_PATH="${REPORT_DIR}/prepared-browser-users.json"
BROWSER_MANIFEST_LOG="${REPORT_DIR}/prepare-browser-users.log"
BROWSER_USER_PASSWORD_VALUE="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}"

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[staging-gate] missing env file: ${ENV_FILE_PATH}" >&2
  echo "[staging-gate] copy .env.staging.private-mirror.example to .env.staging.private-mirror and fill the placeholders" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}"

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE_PATH}" | tail -n 1 | cut -d= -f2- || true
}

is_placeholder_value() {
  local placeholder_pattern='your-|replace|example\.com|example\.net|placeholder|<[^>]+>'
  [[ "${1:-}" =~ ${placeholder_pattern} ]]
}

shared_prod_storage_allowed() {
  local allow_shared
  local storage_prefix

  allow_shared="$(read_env_value STAGING_ALLOW_SHARED_PROD_STORAGE)"
  storage_prefix="$(read_env_value PRIVATE_VIDEO_STORAGE_KEY_PREFIX)"

  [[ "${allow_shared}" =~ ^(1|true|yes|on)$ ]] || return 1
  [[ -n "${storage_prefix}" ]] || return 1
  is_placeholder_value "${storage_prefix}" && return 1
  return 0
}

read_prod_env_value() {
  local key="$1"
  local prod_env_path="${ROOT_DIR}/.env.production"
  if [[ ! -f "${prod_env_path}" ]]; then
    return
  fi
  grep -E "^${key}=" "${prod_env_path}" | tail -n 1 | cut -d= -f2- || true
}

export_env_file() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE_PATH}"
  set +a
}

assert_staging_target() {
  local env_label
  local app_domain
  local live_domain
  local prod_app_domain
  local prod_live_domain

  env_label="$(read_env_value ENVIRONMENT_LABEL)"
  app_domain="$(read_env_value APP_DOMAIN)"
  live_domain="$(read_env_value LIVE_DOMAIN)"
  prod_app_domain="$(read_prod_env_value APP_DOMAIN)"
  prod_live_domain="$(read_prod_env_value LIVE_DOMAIN)"

  if [[ "${ENV_FILE_PATH}" == *".env.production" ]]; then
    echo "[staging-gate] refusing to run with a production env file: ${ENV_FILE_PATH}" >&2
    exit 1
  fi

  if [[ "${env_label}" != "staging-private-mirror" ]]; then
    echo "[staging-gate] ENVIRONMENT_LABEL must be staging-private-mirror, got: ${env_label:-<missing>}" >&2
    exit 1
  fi

  if [[ "${app_domain}" != *.nip.io || "${live_domain}" != *.nip.io ]]; then
    echo "[staging-gate] APP_DOMAIN and LIVE_DOMAIN must be nip.io staging hosts. Got APP_DOMAIN=${app_domain:-<missing>} LIVE_DOMAIN=${live_domain:-<missing>}" >&2
    exit 1
  fi

  if [[ -n "${prod_app_domain}" && "${app_domain}" == "${prod_app_domain}" ]]; then
    echo "[staging-gate] APP_DOMAIN matches production; refusing to continue." >&2
    exit 1
  fi

  if [[ -n "${prod_live_domain}" && "${live_domain}" == "${prod_live_domain}" ]]; then
    echo "[staging-gate] LIVE_DOMAIN matches production; refusing to continue." >&2
    exit 1
  fi
}

assert_staging_storage_credentials() {
  local private_provider
  local hls_provider
  local staging_access_key
  local staging_secret_key
  local prod_access_key
  local prod_secret_key

  private_provider="$(read_env_value PRIVATE_VIDEO_STORAGE_PROVIDER)"
  hls_provider="$(read_env_value VIDEO_HLS_STORAGE_PROVIDER)"
  if [[ "${private_provider}" != "s3" && "${hls_provider}" != "s3" ]]; then
    return
  fi

  staging_access_key="$(read_env_value S3_ACCESS_KEY_ID)"
  staging_secret_key="$(read_env_value S3_SECRET_ACCESS_KEY)"
  if [[ -z "${staging_access_key}" || -z "${staging_secret_key}" ]]; then
    echo "[staging-gate] staging env is missing S3 credentials for mirrored video playback." >&2
    exit 1
  fi

  if is_placeholder_value "${staging_access_key}" || is_placeholder_value "${staging_secret_key}"; then
    echo "[staging-gate] replace staging S3 credential placeholders before running the gate." >&2
    exit 1
  fi

  prod_access_key="$(read_prod_env_value S3_ACCESS_KEY_ID)"
  prod_secret_key="$(read_prod_env_value S3_SECRET_ACCESS_KEY)"
  if [[ -n "${prod_access_key}" && "${staging_access_key}" == "${prod_access_key}" ]]; then
    if ! shared_prod_storage_allowed; then
      echo "[staging-gate] staging S3_ACCESS_KEY_ID matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely." >&2
      exit 1
    fi
  fi
  if [[ -n "${prod_secret_key}" && "${staging_secret_key}" == "${prod_secret_key}" ]]; then
    if ! shared_prod_storage_allowed; then
      echo "[staging-gate] staging S3_SECRET_ACCESS_KEY matches production; enable STAGING_ALLOW_SHARED_PROD_STORAGE=1 with a non-empty PRIVATE_VIDEO_STORAGE_KEY_PREFIX to use the shared R2 bucket safely." >&2
      exit 1
    fi
  fi
}

export_env_file
export ENV_FILE="${ENV_FILE_PATH}"
assert_staging_target
assert_staging_storage_credentials

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  QA_BASE_URL_VALUE="$(read_env_value APP_URL)"
fi

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "[staging-gate] QA_BASE_URL is required, either via env or APP_URL in ${ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ "${QA_BASE_URL_VALUE}" != https://app.*.nip.io* ]]; then
  echo "[staging-gate] QA_BASE_URL must target the staging nip.io app host. Got: ${QA_BASE_URL_VALUE}" >&2
  exit 1
fi

prod_app_domain="$(read_prod_env_value APP_DOMAIN)"
if [[ -n "${prod_app_domain}" && "${QA_BASE_URL_VALUE}" == *"${prod_app_domain}"* ]]; then
  echo "[staging-gate] QA_BASE_URL points at the production app domain; refusing to continue." >&2
  exit 1
fi

export QA_BASE_URL="${QA_BASE_URL_VALUE}"

resolve_stream_target_defaults() {
  if [[ -n "${QA_COURSE_ID_VALUE}" && -n "${QA_LESSON_ID_VALUE}" && -n "${QA_COURSE_TEXT_VALUE}" && -n "${QA_LESSON_TEXT_VALUE}" ]]; then
    return 0
  fi

  if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
    echo "[staging-gate] target manifest missing: ${TARGETS_FILE_VALUE}" >&2
    exit 1
  fi

  local resolved_target
  resolved_target="$(node - "${TARGETS_FILE_VALUE}" "${QA_STREAM_CERT_TARGET_KEY_VALUE}" "${QA_STREAM_CERT_TARGET_INDEX_VALUE}" <<'NODE'
const fs = require('node:fs');
const [targetsPath, requestedKey, requestedIndex] = process.argv.slice(2);
const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
if (!Array.isArray(targets) || targets.length === 0) {
  throw new Error(`No targets found in ${targetsPath}`);
}
let target = targets[0];
if (requestedKey) {
  target = targets.find((entry) => String(entry.key || '').trim() === String(requestedKey).trim());
  if (!target) {
    throw new Error(`Target key not found: ${requestedKey}`);
  }
} else if (requestedIndex) {
  const index = Number(requestedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= targets.length) {
    throw new Error(`Target index out of range: ${requestedIndex}`);
  }
  target = targets[index];
}
process.stdout.write([
  String(target.courseId || ''),
  String(target.lessonId || ''),
  String(target.courseText || ''),
  String(target.lessonText || ''),
].join('\n'));
NODE
)"

  local resolved_values=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    resolved_values+=("${line}")
  done <<< "${resolved_target}"

  QA_COURSE_ID_VALUE="${QA_COURSE_ID_VALUE:-${resolved_values[0]:-}}"
  QA_LESSON_ID_VALUE="${QA_LESSON_ID_VALUE:-${resolved_values[1]:-}}"
  QA_COURSE_TEXT_VALUE="${QA_COURSE_TEXT_VALUE:-${resolved_values[2]:-}}"
  QA_LESSON_TEXT_VALUE="${QA_LESSON_TEXT_VALUE:-${resolved_values[3]:-}}"
  QA_WATCH_LIMIT_COURSE_ID_VALUE="${QA_WATCH_LIMIT_COURSE_ID_VALUE:-${QA_COURSE_ID_VALUE}}"
  QA_WATCH_LIMIT_LESSON_ID_VALUE="${QA_WATCH_LIMIT_LESSON_ID_VALUE:-${QA_LESSON_ID_VALUE}}"
  QA_WATCH_LIMIT_COURSE_TEXT_VALUE="${QA_WATCH_LIMIT_COURSE_TEXT_VALUE:-${QA_COURSE_TEXT_VALUE}}"
  QA_WATCH_LIMIT_LESSON_TEXT_VALUE="${QA_WATCH_LIMIT_LESSON_TEXT_VALUE:-${QA_LESSON_TEXT_VALUE}}"
}

max_browser_users_required() {
  local highest_stage=0
  local value
  IFS=',' read -r -a stage_values <<< "${QA_VIDEO_BROWSER_STAGES_VALUE}"
  for value in "${stage_values[@]}"; do
    value="$(echo "${value}" | tr -d '[:space:]')"
    if [[ "${value}" =~ ^[0-9]+$ && "${value}" -gt "${highest_stage}" ]]; then
      highest_stage="${value}"
    fi
  done

  if [[ "${RUN_HYBRID_3K_VALUE}" == "1" && "${HYBRID_3K_BROWSER_USERS}" -gt "${highest_stage}" ]]; then
    highest_stage="${HYBRID_3K_BROWSER_USERS}"
  fi
  if [[ "${RUN_HYBRID_4K_VALUE}" == "1" && "${HYBRID_4K_BROWSER_USERS}" -gt "${highest_stage}" ]]; then
    highest_stage="${HYBRID_4K_BROWSER_USERS}"
  fi
  if [[ "${highest_stage}" -le 0 ]]; then
    highest_stage=50
  fi
  echo "${highest_stage}"
}

extract_entry_bundle() {
  curl -k -sS --max-time 20 "${QA_BASE_URL_VALUE}/" \
    | grep -oE '/assets/index-[^"]+\.js' \
    | head -n 1 || true
}

check_entry_bundle_consistency() {
  local expected=""
  local bundle=""
  local attempt
  for attempt in $(seq 1 "${HEALTH_CHECK_REPEATS}"); do
    bundle="$(extract_entry_bundle)"
    echo "[staging-gate] entry bundle ${attempt}: ${bundle}" | tee -a "${REPORT_DIR}/gate.log"
    if [[ -z "${bundle}" ]]; then
      echo "[staging-gate] unable to extract entry bundle from ${QA_BASE_URL_VALUE}/" >&2
      exit 1
    fi
    if [[ -n "${expected}" && "${bundle}" != "${expected}" ]]; then
      echo "[staging-gate] inconsistent entry bundle hash served: ${expected} vs ${bundle}" >&2
      exit 1
    fi
    expected="${bundle}"
  done
}

check_endpoint_repeated_200() {
  local url="$1"
  local attempt
  local status
  for attempt in $(seq 1 "${HEALTH_CHECK_REPEATS}"); do
    status="$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${url}")"
    echo "[staging-gate] ${status} ${url} (attempt ${attempt}/${HEALTH_CHECK_REPEATS})" | tee -a "${REPORT_DIR}/gate.log"
    if [[ ! "${status}" =~ ^2[0-9][0-9]$ ]]; then
      echo "[staging-gate] endpoint check failed for ${url}" >&2
      exit 1
    fi
  done
}

run_logged_qa() {
  local label="$1"
  shift
  local log_file="${REPORT_DIR}/${label}.log"
  echo "[staging-gate] running ${label}" | tee -a "${REPORT_DIR}/gate.log"
  (
    cd "${ROOT_DIR}/qa-automation"
    "$@"
  ) >"${log_file}" 2>&1
  echo "[staging-gate] completed ${label}; log=${log_file}" | tee -a "${REPORT_DIR}/gate.log"
}

prepare_browser_user_manifest() {
  if [[ -n "${PLATFORM_LOAD_USERS_FILE_VALUE}" && -f "${PLATFORM_LOAD_USERS_FILE_VALUE}" ]]; then
    echo "[staging-gate] using provided browser user manifest: ${PLATFORM_LOAD_USERS_FILE_VALUE}" | tee -a "${REPORT_DIR}/gate.log"
    COURSE_LOAD_USERS_FILE_VALUE="${PLATFORM_LOAD_USERS_FILE_VALUE}"
    return
  fi

  if [[ -n "${COURSE_LOAD_USERS_FILE_VALUE}" && -f "${COURSE_LOAD_USERS_FILE_VALUE}" ]]; then
    echo "[staging-gate] using provided course browser user manifest: ${COURSE_LOAD_USERS_FILE_VALUE}" | tee -a "${REPORT_DIR}/gate.log"
    PLATFORM_LOAD_USERS_FILE_VALUE="${COURSE_LOAD_USERS_FILE_VALUE}"
    return
  fi

  local required_users
  required_users="$(max_browser_users_required)"
  echo "[staging-gate] preparing browser user manifest for ${required_users} viewers" | tee -a "${REPORT_DIR}/gate.log"
  (
    cd "${ROOT_DIR}/qa-automation"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS="${required_users}" \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${BROWSER_MANIFEST_PATH}" \
    PLATFORM_LOAD_USER_PASSWORD="${BROWSER_USER_PASSWORD_VALUE}" \
    npm run browser:prepare-video-browser-manifest
  ) >"${BROWSER_MANIFEST_LOG}" 2>&1

  if [[ ! -f "${BROWSER_MANIFEST_PATH}" ]]; then
    echo "[staging-gate] failed to create browser user manifest at ${BROWSER_MANIFEST_PATH}" >&2
    exit 1
  fi

  PLATFORM_LOAD_USERS_FILE_VALUE="${BROWSER_MANIFEST_PATH}"
  COURSE_LOAD_USERS_FILE_VALUE="${BROWSER_MANIFEST_PATH}"
  echo "[staging-gate] prepared browser user manifest: ${BROWSER_MANIFEST_PATH}" | tee -a "${REPORT_DIR}/gate.log"
}

extract_first_manifest_email() {
  local manifest_path="$1"
  node -e "const fs=require('node:fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(data?.[0]?.email || ''));" "${manifest_path}"
}

prepare_platform_user_manifest() {
  local required_users="$1"
  if [[ -n "${PLATFORM_LOAD_USERS_FILE_VALUE}" && -f "${PLATFORM_LOAD_USERS_FILE_VALUE}" ]]; then
    echo "[staging-gate] using provided diagnostic user manifest: ${PLATFORM_LOAD_USERS_FILE_VALUE}" | tee -a "${REPORT_DIR}/gate.log"
    return
  fi

  local prepare_log="${REPORT_DIR}/platform-prepare-${required_users}.log"
  echo "[staging-gate] preparing diagnostic user manifest for ${required_users} users" | tee -a "${REPORT_DIR}/gate.log"
  (
    cd "${ROOT_DIR}/qa-automation"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    PLATFORM_LOAD_USERS="${required_users}" \
    PLATFORM_LOAD_SETUP_CONCURRENCY="${HYBRID_PLATFORM_SETUP_CONCURRENCY}" \
    PLATFORM_LOAD_PREPARE_ONLY="true" \
    PLATFORM_LOAD_REUSE_EXISTING_USERS="true" \
    PLATFORM_LOAD_TOP_UP_EXISTING_USERS="true" \
    PLATFORM_LOAD_REFRESH_EXISTING_TOKENS="true" \
    npm run load:platform
  ) >"${prepare_log}" 2>&1

  PLATFORM_LOAD_USERS_FILE_VALUE="$(ls -td "${ROOT_DIR}"/qa-automation/reports/platform-1000-*/prepared-users.json 2>/dev/null | head -n 1 || true)"
  if [[ -z "${PLATFORM_LOAD_USERS_FILE_VALUE}" ]]; then
    echo "[staging-gate] failed to locate prepared platform user manifest after prepare-only run" >&2
    exit 1
  fi
  echo "[staging-gate] prepared diagnostic user manifest: ${PLATFORM_LOAD_USERS_FILE_VALUE}" | tee -a "${REPORT_DIR}/gate.log"
}

run_hybrid_stage() {
  local label="$1"
  local browser_users="$2"
  local diagnostic_users="$3"
  local browser_log="${REPORT_DIR}/${label}-browser.log"
  local platform_log="${REPORT_DIR}/${label}-platform.log"
  local browser_pid
  local platform_pid
  local browser_status=0
  local platform_status=0
  local active_concurrency="${HYBRID_PLATFORM_ACTIVE_CONCURRENCY:-${diagnostic_users}}"

  echo "[staging-gate] starting hybrid stage ${label}: browsers=${browser_users}, diagnostic=${diagnostic_users}" | tee -a "${REPORT_DIR}/gate.log"

  (
    cd "${ROOT_DIR}/qa-automation"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_VIDEO_BROWSER_STAGES="${browser_users}" \
    QA_VIDEO_BROWSER_STAGE_CONCURRENCY="${browser_users}" \
    npm run browser:course-video-browser-concurrency
  ) >"${browser_log}" 2>&1 &
  browser_pid=$!

  (
    cd "${ROOT_DIR}/qa-automation"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    PLATFORM_LOAD_USERS="${diagnostic_users}" \
    PLATFORM_LOAD_ACTIVE_CONCURRENCY="${active_concurrency}" \
    PLATFORM_LOAD_SETUP_CONCURRENCY="${HYBRID_PLATFORM_SETUP_CONCURRENCY}" \
    PLATFORM_LOAD_USERS_FILE="${PLATFORM_LOAD_USERS_FILE_VALUE}" \
    PLATFORM_LOAD_REUSE_EXISTING_USERS="true" \
    PLATFORM_LOAD_TOP_UP_EXISTING_USERS="true" \
    PLATFORM_LOAD_REFRESH_EXISTING_TOKENS="true" \
    npm run load:platform
  ) >"${platform_log}" 2>&1 &
  platform_pid=$!

  set +e
  wait "${browser_pid}"
  browser_status=$?
  wait "${platform_pid}"
  platform_status=$?
  set -e

  echo "[staging-gate] hybrid ${label} browser exit=${browser_status}; log=${browser_log}" | tee -a "${REPORT_DIR}/gate.log"
  echo "[staging-gate] hybrid ${label} platform exit=${platform_status}; log=${platform_log}" | tee -a "${REPORT_DIR}/gate.log"

  if [[ "${browser_status}" -ne 0 || "${platform_status}" -ne 0 ]]; then
    echo "[staging-gate] hybrid stage ${label} failed" >&2
    exit 1
  fi
}

echo "[staging-gate] validating config via ${ENV_FILE_PATH}" | tee -a "${REPORT_DIR}/gate.log"
(cd "${ROOT_DIR}" && ENV_FILE="${ENV_FILE_PATH}" npm run validate:production) >"${REPORT_DIR}/validate-production.log" 2>&1

echo "[staging-gate] checking staging endpoints" | tee -a "${REPORT_DIR}/gate.log"
check_entry_bundle_consistency
check_endpoint_repeated_200 "${QA_BASE_URL_VALUE}/"
check_endpoint_repeated_200 "${QA_BASE_URL_VALUE}/backend/api/live"
check_endpoint_repeated_200 "${QA_BASE_URL_VALUE}/backend/api/ready"
check_endpoint_repeated_200 "${QA_BASE_URL_VALUE}/backend/api/health"
resolve_stream_target_defaults
echo "[staging-gate] using target course=${QA_COURSE_ID_VALUE} lesson=${QA_LESSON_ID_VALUE} courseText=${QA_COURSE_TEXT_VALUE} lessonText=${QA_LESSON_TEXT_VALUE}" | tee -a "${REPORT_DIR}/gate.log"

prepare_browser_user_manifest
FIRST_QA_EMAIL="$(extract_first_manifest_email "${PLATFORM_LOAD_USERS_FILE_VALUE}")"
if [[ -z "${FIRST_QA_EMAIL}" ]]; then
  echo "[staging-gate] unable to resolve the first QA browser user email from ${PLATFORM_LOAD_USERS_FILE_VALUE}" >&2
  exit 1
fi

run_logged_qa "course-playback-rootcause" env \
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_LOGIN_EMAIL="${FIRST_QA_EMAIL}" \
  QA_LOGIN_PASSWORD="${BROWSER_USER_PASSWORD_VALUE}" \
  QA_COURSE_ID="${QA_COURSE_ID_VALUE}" \
  QA_LESSON_ID="${QA_LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${QA_COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${QA_LESSON_TEXT_VALUE}" \
  npm run browser:course-playback-rootcause

run_logged_qa "course-video-browser-concurrency" env \
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_COURSE_ID="${QA_COURSE_ID_VALUE}" \
  QA_LESSON_ID="${QA_LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${QA_COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${QA_LESSON_TEXT_VALUE}" \
  QA_VIDEO_BROWSER_STAGES="${QA_VIDEO_BROWSER_STAGES_VALUE}" \
  PLATFORM_LOAD_USERS_FILE="${PLATFORM_LOAD_USERS_FILE_VALUE}" \
  COURSE_LOAD_USERS_FILE="${COURSE_LOAD_USERS_FILE_VALUE}" \
  npm run browser:course-video-browser-concurrency

if [[ "${RUN_WATCH_LIMIT_VALUE}" == "1" ]]; then
  run_logged_qa "course-watch-limit-regression" env \
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_LOGIN_PASSWORD="${BROWSER_USER_PASSWORD_VALUE}" \
    QA_WATCH_LIMIT_COURSE_ID="${QA_WATCH_LIMIT_COURSE_ID_VALUE}" \
    QA_WATCH_LIMIT_LESSON_ID="${QA_WATCH_LIMIT_LESSON_ID_VALUE}" \
    QA_WATCH_LIMIT_COURSE_TEXT="${QA_WATCH_LIMIT_COURSE_TEXT_VALUE}" \
    QA_WATCH_LIMIT_LESSON_TEXT="${QA_WATCH_LIMIT_LESSON_TEXT_VALUE}" \
    npm run browser:course-watch-limit-regression
fi

if [[ "${RUN_HYBRID_3K_VALUE}" == "1" || "${RUN_HYBRID_4K_VALUE}" == "1" ]]; then
  max_diagnostic_users="${HYBRID_3K_DIAGNOSTIC_USERS}"
  if [[ "${RUN_HYBRID_4K_VALUE}" == "1" && "${HYBRID_4K_DIAGNOSTIC_USERS}" -gt "${max_diagnostic_users}" ]]; then
    max_diagnostic_users="${HYBRID_4K_DIAGNOSTIC_USERS}"
  fi
  prepare_platform_user_manifest "${max_diagnostic_users}"
fi

if [[ "${RUN_HYBRID_3K_VALUE}" == "1" ]]; then
  run_hybrid_stage "hybrid-3k" "${HYBRID_3K_BROWSER_USERS}" "${HYBRID_3K_DIAGNOSTIC_USERS}"
fi

if [[ "${RUN_HYBRID_4K_VALUE}" == "1" ]]; then
  run_hybrid_stage "hybrid-4k" "${HYBRID_4K_BROWSER_USERS}" "${HYBRID_4K_DIAGNOSTIC_USERS}"
fi

node - "${REPORT_DIR}/gate-summary.json" "${QA_BASE_URL_VALUE}" "${ENV_FILE_PATH}" "${QA_COURSE_ID_VALUE}" "${QA_LESSON_ID_VALUE}" "${QA_COURSE_TEXT_VALUE}" "${QA_LESSON_TEXT_VALUE}" "${RUN_WATCH_LIMIT_VALUE}" "${QA_VIDEO_BROWSER_STAGES_VALUE}" "${REPORT_DIR}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  baseUrl,
  envFile,
  courseId,
  lessonId,
  courseText,
  lessonText,
  watchLimitEnabled,
  stages,
  reportDir,
] = process.argv.slice(2);

fs.writeFileSync(outputPath, JSON.stringify({
  ok: true,
  baseUrl,
  envFile,
  courseId,
  lessonId,
  courseText,
  lessonText,
  watchLimitEnabled: ['1', 'true', 'yes', 'on'].includes(String(watchLimitEnabled || '').toLowerCase()),
  stages,
  reportDir,
}, null, 2));
NODE

echo "[staging-gate] staging mirror gate completed; artifacts=${REPORT_DIR}" | tee -a "${REPORT_DIR}/gate.log"
