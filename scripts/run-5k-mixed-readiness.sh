#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_BASE_URL_VALUE="${QA_BASE_URL:-${1:-}}"
ENV_FILE_VALUE="${ENV_FILE:-.env.production}"
QA_COURSE_TEXT_VALUE="${QA_COURSE_TEXT:-}"
QA_LESSON_TEXT_VALUE="${QA_LESSON_TEXT:-}"
QA_WATCH_LIMIT_COURSE_ID_VALUE="${QA_WATCH_LIMIT_COURSE_ID:-}"
QA_WATCH_LIMIT_LESSON_ID_VALUE="${QA_WATCH_LIMIT_LESSON_ID:-}"
QA_WATCH_LIMIT_COURSE_TEXT_VALUE="${QA_WATCH_LIMIT_COURSE_TEXT:-${QA_COURSE_TEXT_VALUE}}"
QA_WATCH_LIMIT_LESSON_TEXT_VALUE="${QA_WATCH_LIMIT_LESSON_TEXT:-${QA_LESSON_TEXT_VALUE}}"

DRY_RUN_VALUE="${FIVE_K_MIXED_DRY_RUN:-0}"
SKIP_ROOTCAUSE_VALUE="${FIVE_K_SKIP_ROOTCAUSE:-0}"
SKIP_WATCH_LIMIT_VALUE="${FIVE_K_SKIP_WATCH_LIMIT:-0}"
SKIP_SMOOTH_PLAYBACK_VALUE="${FIVE_K_SKIP_SMOOTH_PLAYBACK:-0}"
SKIP_RECORDED_BROWSER_VALUE="${FIVE_K_SKIP_RECORDED_BROWSER:-0}"
SKIP_RECORDED_SYNTHETIC_VALUE="${FIVE_K_SKIP_RECORDED_SYNTHETIC:-0}"
SKIP_PLATFORM_VALUE="${FIVE_K_SKIP_PLATFORM:-0}"

RECORDED_BROWSER_STAGES="${FIVE_K_RECORDED_BROWSER_STAGES:-50,100,250}"
RECORDED_SYNTHETIC_STAGES="${FIVE_K_RECORDED_SYNTHETIC_STAGES:-250,500,750,1000}"
PLATFORM_STAGES="${FIVE_K_PLATFORM_STAGES:-2000,5000}"

export QA_BASE_URL="${QA_BASE_URL_VALUE}"
export ENV_FILE="${ENV_FILE_VALUE}"
export PLATFORM_LOAD_TRAFFIC_MODEL="${PLATFORM_LOAD_TRAFFIC_MODEL:-5k-mixed}"
export PLATFORM_LOAD_BROWSE_READ_PERCENT="${PLATFORM_LOAD_BROWSE_READ_PERCENT:-70}"
export PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT="${PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT:-15}"
export PLATFORM_LOAD_AUTH_SESSION_PERCENT="${PLATFORM_LOAD_AUTH_SESSION_PERCENT:-10}"
export PLATFORM_LOAD_LIGHT_WRITE_PERCENT="${PLATFORM_LOAD_LIGHT_WRITE_PERCENT:-5}"
export PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS="${PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS:-1}"
export PLATFORM_LOAD_ENABLE_PROFILE_UPDATE="${PLATFORM_LOAD_ENABLE_PROFILE_UPDATE:-1}"
export PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT="${PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT:-0}"
export PLATFORM_LOAD_ENABLE_LIVE="${PLATFORM_LOAD_ENABLE_LIVE:-0}"
export PLATFORM_LOAD_ENABLE_ENROLL="${PLATFORM_LOAD_ENABLE_ENROLL:-0}"
export COURSE_LOAD_REPORT_PREFIX_BASE="${COURSE_LOAD_REPORT_PREFIX_BASE:-course-video-5k-mixed}"
export PLATFORM_LOAD_REPORT_PREFIX_BASE="${PLATFORM_LOAD_REPORT_PREFIX_BASE:-platform-5k-mixed}"

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "Usage: QA_BASE_URL=https://app.example.com $0" >&2
  echo "   or: $0 https://app.example.com" >&2
  exit 1
fi

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "[5k-mixed] missing required value: ${name}" >&2
    exit 1
  fi
}

run_cmd() {
  local label="$1"
  shift
  echo "[5k-mixed] ${label}"
  if [[ "${DRY_RUN_VALUE}" == "1" ]]; then
    printf '  '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  (
    cd "${ROOT_DIR}"
    "$@"
  )
}

csv_to_lines() {
  local csv="$1"
  local value
  IFS=',' read -r -a values <<< "${csv}"
  for value in "${values[@]}"; do
    value="$(echo "${value}" | tr -d '[:space:]')"
    [[ -n "${value}" ]] && echo "${value}"
  done
}

if [[ "${SKIP_ROOTCAUSE_VALUE}" != "1" ]]; then
  require_value "QA_COURSE_TEXT" "${QA_COURSE_TEXT_VALUE}"
  require_value "QA_LESSON_TEXT" "${QA_LESSON_TEXT_VALUE}"
  export QA_COURSE_TEXT="${QA_COURSE_TEXT_VALUE}"
  export QA_LESSON_TEXT="${QA_LESSON_TEXT_VALUE}"
  run_cmd "desktop root-cause regression" \
    npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
  run_cmd "mobile root-cause regression" \
    env QA_MOBILE_MODE=1 npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
fi

if [[ "${SKIP_WATCH_LIMIT_VALUE}" != "1" ]]; then
  require_value "QA_WATCH_LIMIT_COURSE_ID" "${QA_WATCH_LIMIT_COURSE_ID_VALUE}"
  require_value "QA_WATCH_LIMIT_LESSON_ID" "${QA_WATCH_LIMIT_LESSON_ID_VALUE}"
  require_value "QA_WATCH_LIMIT_COURSE_TEXT or QA_COURSE_TEXT" "${QA_WATCH_LIMIT_COURSE_TEXT_VALUE}"
  require_value "QA_WATCH_LIMIT_LESSON_TEXT or QA_LESSON_TEXT" "${QA_WATCH_LIMIT_LESSON_TEXT_VALUE}"
  run_cmd "watch-limit regression" \
    env \
    QA_AUTOMATION_CLEANUP_MODE=execute \
    QA_WATCH_LIMIT_COURSE_ID="${QA_WATCH_LIMIT_COURSE_ID_VALUE}" \
    QA_WATCH_LIMIT_LESSON_ID="${QA_WATCH_LIMIT_LESSON_ID_VALUE}" \
    QA_WATCH_LIMIT_COURSE_TEXT="${QA_WATCH_LIMIT_COURSE_TEXT_VALUE}" \
    QA_WATCH_LIMIT_LESSON_TEXT="${QA_WATCH_LIMIT_LESSON_TEXT_VALUE}" \
    npm --prefix qa-automation run browser:video-false-completion-after-pause-powercut-regression
fi

if [[ "${SKIP_SMOOTH_PLAYBACK_VALUE}" != "1" ]]; then
  run_cmd "smooth playback regression" \
    npm --prefix qa-automation run browser:smooth-video-playback-regression
fi

if [[ "${SKIP_RECORDED_BROWSER_VALUE}" != "1" ]]; then
  while IFS= read -r stage; do
    run_cmd "recorded-browser ladder stage ${stage}" \
      env QA_VIDEO_BROWSER_STAGES="${stage}" \
      ./scripts/run-recorded-browser-ladder.sh
  done < <(csv_to_lines "${RECORDED_BROWSER_STAGES}")
fi

if [[ "${SKIP_RECORDED_SYNTHETIC_VALUE}" != "1" ]]; then
  while IFS= read -r stage; do
    run_cmd "recorded-video synthetic stage ${stage}" \
      env COURSE_VIDEO_LADDER_STAGES="${stage}" \
      ./scripts/run-course-video-ladder.sh
  done < <(csv_to_lines "${RECORDED_SYNTHETIC_STAGES}")
fi

if [[ "${SKIP_PLATFORM_VALUE}" != "1" ]]; then
  while IFS= read -r stage; do
    run_cmd "mixed-platform stage ${stage}" \
      env PLATFORM_LADDER_STAGES="${stage}" \
      ./scripts/run-platform-scale-ladder.sh
  done < <(csv_to_lines "${PLATFORM_STAGES}")
fi

echo "[5k-mixed] certification sequence complete"
