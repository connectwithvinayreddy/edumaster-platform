#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_BASE_URL_VALUE="${QA_BASE_URL:-${1:-}}"
COURSE_VIDEO_LADDER_STAGES="${COURSE_VIDEO_LADDER_STAGES:-250,500,750,1000}"
SETUP_CONCURRENCY="${COURSE_LOAD_SETUP_CONCURRENCY:-3}"
TIMEOUT_MS="${COURSE_LOAD_TIMEOUT_MS:-30000}"
MANIFEST_FILE="${COURSE_LOAD_USERS_FILE:-}"
COURSE_ID_VALUE="${COURSE_LOAD_COURSE_ID:-course_1899470118af44b4b9447b35fd296761}"
LESSON_ID_VALUE="${COURSE_LOAD_LESSON_ID:-video_1778758229576}"
COURSE_LOAD_REPORT_PREFIX_BASE="${COURSE_LOAD_REPORT_PREFIX_BASE:-course-video-scale}"
COURSE_LOAD_PREPARE_REPORT_PREFIX="${COURSE_LOAD_PREPARE_REPORT_PREFIX:-${COURSE_LOAD_REPORT_PREFIX_BASE}-prepare}"

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

PREPARE_COUNT="${COURSE_LOAD_PREPARE_USERS:-$(max_stage_from_csv "${COURSE_VIDEO_LADDER_STAGES}")}"

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "Usage: QA_BASE_URL=https://app.example.com $0" >&2
  echo "   or: $0 https://app.example.com" >&2
  exit 1
fi

find_latest_manifest() {
  local report_prefix="$1"
  local matches=()

  shopt -s nullglob
  matches=( "${ROOT_DIR}"/reports/"${report_prefix}"-*/prepared-users.json )
  shopt -u nullglob

  if [[ "${#matches[@]}" -eq 0 ]]; then
    return 1
  fi

  printf '%s\n' "${matches[@]}" | sort | tail -n 1
}

run_course_video_load() {
  local users="$1"
  local active_concurrency="$2"
  local prepare_only="${3:-false}"
  local report_prefix="$4"

  echo "[course-video] starting run: users=${users} active=${active_concurrency} prepare_only=${prepare_only} prefix=${report_prefix}"
  (
    cd "${ROOT_DIR}"
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    COURSE_LOAD_USERS="${users}" \
    COURSE_LOAD_ACTIVE_CONCURRENCY="${active_concurrency}" \
    COURSE_LOAD_SETUP_CONCURRENCY="${SETUP_CONCURRENCY}" \
    COURSE_LOAD_TIMEOUT_MS="${TIMEOUT_MS}" \
    COURSE_LOAD_COURSE_ID="${COURSE_ID_VALUE}" \
    COURSE_LOAD_LESSON_ID="${LESSON_ID_VALUE}" \
    COURSE_LOAD_PREPARE_ONLY="${prepare_only}" \
    COURSE_LOAD_USERS_FILE="${MANIFEST_FILE}" \
    COURSE_LOAD_REPORT_PREFIX="${report_prefix}" \
    npm --prefix qa-automation run load:course-video
  )
}

if [[ -z "${MANIFEST_FILE}" ]]; then
  echo "[course-video] no prepared user manifest supplied; running prepare-only pass"
  run_course_video_load "${PREPARE_COUNT}" 0 true "${COURSE_LOAD_PREPARE_REPORT_PREFIX}"
  MANIFEST_FILE="$(find_latest_manifest "${COURSE_LOAD_PREPARE_REPORT_PREFIX}" || true)"
  if [[ -z "${MANIFEST_FILE}" ]]; then
    echo "[course-video] unable to locate prepared-users.json after prepare-only run" >&2
    exit 1
  fi
  echo "[course-video] using generated manifest: ${MANIFEST_FILE}"
else
  echo "[course-video] using provided manifest: ${MANIFEST_FILE}"
fi

IFS=',' read -r -a ladder_stage_values <<< "${COURSE_VIDEO_LADDER_STAGES}"
for stage_value in "${ladder_stage_values[@]}"; do
  stage_value="$(echo "${stage_value}" | tr -d '[:space:]')"
  if [[ ! "${stage_value}" =~ ^[0-9]+$ || "${stage_value}" -le 0 ]]; then
    echo "[course-video] skipping invalid ladder stage: ${stage_value}" >&2
    continue
  fi
  run_course_video_load "${stage_value}" "${stage_value}" false "${COURSE_LOAD_REPORT_PREFIX_BASE}-${stage_value}"
done

echo "[course-video] ladder complete"
