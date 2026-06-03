#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_BASE_URL_VALUE="${QA_BASE_URL:-${1:-}}"
PLATFORM_LADDER_STAGES="${PLATFORM_LADDER_STAGES:-2000,5000,10000,15000}"
SETUP_CONCURRENCY="${PLATFORM_LOAD_SETUP_CONCURRENCY:-50}"
TIMEOUT_MS="${PLATFORM_LOAD_TIMEOUT_MS:-30000}"
MANIFEST_FILE="${PLATFORM_LOAD_USERS_FILE:-}"
ACTIVE_CONCURRENCY_OVERRIDE="${PLATFORM_LOAD_ACTIVE_CONCURRENCY:-}"
PLATFORM_LOAD_REPORT_PREFIX_BASE="${PLATFORM_LOAD_REPORT_PREFIX_BASE:-platform-scale}"
PLATFORM_LOAD_PREPARE_REPORT_PREFIX="${PLATFORM_LOAD_PREPARE_REPORT_PREFIX:-${PLATFORM_LOAD_REPORT_PREFIX_BASE}-prepare}"
ENABLE_VIDEO_PROGRESS_VALUE="${PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS:-1}"
ENABLE_PAYMENT_CHECKOUT_VALUE="${PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT:-0}"
ENABLE_LIVE_VALUE="${PLATFORM_LOAD_ENABLE_LIVE:-0}"
ENABLE_ENROLL_VALUE="${PLATFORM_LOAD_ENABLE_ENROLL:-0}"
ENABLE_PROFILE_UPDATE_VALUE="${PLATFORM_LOAD_ENABLE_PROFILE_UPDATE:-0}"
REUSE_EXISTING_USERS_VALUE="${PLATFORM_LOAD_REUSE_EXISTING_USERS:-1}"
TOP_UP_EXISTING_USERS_VALUE="${PLATFORM_LOAD_TOP_UP_EXISTING_USERS:-1}"

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

PREPARE_COUNT="${PLATFORM_LOAD_PREPARE_USERS:-$(max_stage_from_csv "${PLATFORM_LADDER_STAGES}")}"

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

run_platform_load() {
  local users="$1"
  local active_concurrency="$2"
  local prepare_only="${3:-false}"
  local report_prefix="$4"

  echo "[platform-scale] starting run: users=${users} active=${active_concurrency} prepare_only=${prepare_only} prefix=${report_prefix}"
  (
    cd "${ROOT_DIR}"
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    PLATFORM_LOAD_USERS="${users}" \
    PLATFORM_LOAD_ACTIVE_CONCURRENCY="${active_concurrency}" \
    PLATFORM_LOAD_SETUP_CONCURRENCY="${SETUP_CONCURRENCY}" \
    PLATFORM_LOAD_TIMEOUT_MS="${TIMEOUT_MS}" \
    PLATFORM_LOAD_PREPARE_ONLY="${prepare_only}" \
    PLATFORM_LOAD_USERS_FILE="${MANIFEST_FILE}" \
    PLATFORM_LOAD_REPORT_PREFIX="${report_prefix}" \
    PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS="${ENABLE_VIDEO_PROGRESS_VALUE}" \
    PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT="${ENABLE_PAYMENT_CHECKOUT_VALUE}" \
    PLATFORM_LOAD_ENABLE_LIVE="${ENABLE_LIVE_VALUE}" \
    PLATFORM_LOAD_ENABLE_ENROLL="${ENABLE_ENROLL_VALUE}" \
    PLATFORM_LOAD_ENABLE_PROFILE_UPDATE="${ENABLE_PROFILE_UPDATE_VALUE}" \
    PLATFORM_LOAD_REUSE_EXISTING_USERS="${REUSE_EXISTING_USERS_VALUE}" \
    PLATFORM_LOAD_TOP_UP_EXISTING_USERS="${TOP_UP_EXISTING_USERS_VALUE}" \
    npm --prefix qa-automation run load:platform
  )
}

if [[ -z "${MANIFEST_FILE}" ]]; then
  echo "[platform-scale] no prepared user manifest supplied; running prepare-only pass"
  run_platform_load "${PREPARE_COUNT}" 0 true "${PLATFORM_LOAD_PREPARE_REPORT_PREFIX}"
  MANIFEST_FILE="$(find_latest_manifest "${PLATFORM_LOAD_PREPARE_REPORT_PREFIX}" || true)"
  if [[ -z "${MANIFEST_FILE}" ]]; then
    echo "[platform-scale] unable to locate prepared-users.json after prepare-only run" >&2
    exit 1
  fi
  echo "[platform-scale] using generated manifest: ${MANIFEST_FILE}"
else
  echo "[platform-scale] using provided manifest: ${MANIFEST_FILE}"
fi

IFS=',' read -r -a ladder_stage_values <<< "${PLATFORM_LADDER_STAGES}"
for stage_value in "${ladder_stage_values[@]}"; do
  stage_value="$(echo "${stage_value}" | tr -d '[:space:]')"
  if [[ ! "${stage_value}" =~ ^[0-9]+$ || "${stage_value}" -le 0 ]]; then
    echo "[platform-scale] skipping invalid ladder stage: ${stage_value}" >&2
    continue
  fi
  active_concurrency="${ACTIVE_CONCURRENCY_OVERRIDE:-${stage_value}}"
  run_platform_load "${stage_value}" "${active_concurrency}" false "${PLATFORM_LOAD_REPORT_PREFIX_BASE}-${stage_value}"
done

echo "[platform-scale] ladder complete"
