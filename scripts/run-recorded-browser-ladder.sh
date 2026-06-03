#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_BASE_URL_VALUE="${QA_BASE_URL:-${1:-}}"
QA_VIDEO_BROWSER_STAGES_VALUE="${QA_VIDEO_BROWSER_STAGES:-50,100,250}"
MANIFEST_FILE="${PLATFORM_LOAD_USERS_FILE:-${COURSE_LOAD_USERS_FILE:-}}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/recorded-browser-ladder-${RUN_ID}"

max_stage_from_csv() {
  local csv="$1"
  local max_value=0
  local value
  IFS=',' read -r -a values <<< "${csv}"
  for value in "${values[@]}"; do
    value="$(echo "${value}" | tr -d '[:space:]')"
    if [[ "${value}" =~ ^[0-9]+$ && "${value}" -gt "${max_value}" ]]; then
      max_value="${value}"
    fi
  done
  echo "${max_value}"
}

QA_VIDEO_BROWSER_MANIFEST_USERS_VALUE="${QA_VIDEO_BROWSER_MANIFEST_USERS:-$(max_stage_from_csv "${QA_VIDEO_BROWSER_STAGES_VALUE}")}"
QA_VIDEO_BROWSER_MANIFEST_PATH_VALUE="${QA_VIDEO_BROWSER_MANIFEST_PATH:-${REPORT_DIR}/prepared-browser-users.json}"

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "Usage: QA_BASE_URL=https://app.example.com $0" >&2
  echo "   or: $0 https://app.example.com" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}"

if [[ -z "${MANIFEST_FILE}" ]]; then
  echo "[recorded-browser] no browser manifest supplied; preparing ${QA_VIDEO_BROWSER_MANIFEST_USERS_VALUE} QA users"
  (
    cd "${ROOT_DIR}"
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS="${QA_VIDEO_BROWSER_MANIFEST_USERS_VALUE}" \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${QA_VIDEO_BROWSER_MANIFEST_PATH_VALUE}" \
    npm --prefix qa-automation run browser:prepare-video-browser-manifest
  )
  MANIFEST_FILE="${QA_VIDEO_BROWSER_MANIFEST_PATH_VALUE}"
  echo "[recorded-browser] using generated manifest: ${MANIFEST_FILE}"
else
  echo "[recorded-browser] using provided manifest: ${MANIFEST_FILE}"
fi

(
  cd "${ROOT_DIR}"
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_VIDEO_BROWSER_STAGES="${QA_VIDEO_BROWSER_STAGES_VALUE}" \
  PLATFORM_LOAD_USERS_FILE="${MANIFEST_FILE}" \
  COURSE_LOAD_USERS_FILE="${MANIFEST_FILE}" \
  npm --prefix qa-automation run browser:course-video-browser-concurrency
)

echo "[recorded-browser] ladder complete"
