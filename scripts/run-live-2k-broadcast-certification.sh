#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
QA_BASE_URL_VALUE="${QA_BASE_URL:-}"
VIEWERS_VALUE="${LIVE_LOAD_VIEWERS:-2000}"
SETUP_CONCURRENCY_VALUE="${LIVE_LOAD_SETUP_CONCURRENCY:-75}"
ACTIVE_CONCURRENCY_VALUE="${LIVE_LOAD_CONCURRENCY:-250}"
SOAK_MINUTES_VALUE="${LIVE_LOAD_SOAK_MINUTES:-5}"
REPORT_SCOPE="${REPORT_SCOPE:-live-2k-broadcast-cert}"

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[live-2k-cert] missing env file: ${ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  QA_BASE_URL_VALUE="$(grep -E '^APP_URL=' "${ENV_FILE_PATH}" | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "[live-2k-cert] QA_BASE_URL is required." >&2
  exit 1
fi

REPORT_DIR="${ROOT_DIR}/reports/${REPORT_SCOPE}-$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
mkdir -p "${REPORT_DIR}"

echo "[live-2k-cert] env=${ENV_FILE_PATH}" | tee "${REPORT_DIR}/run.log"
echo "[live-2k-cert] base_url=${QA_BASE_URL_VALUE}" | tee -a "${REPORT_DIR}/run.log"
echo "[live-2k-cert] viewers=${VIEWERS_VALUE} active_concurrency=${ACTIVE_CONCURRENCY_VALUE}" | tee -a "${REPORT_DIR}/run.log"

(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_LIVE_CERT_PLAYBACK_MODE=live-stream \
  npm --prefix qa-automation run browser:live-cert
) | tee "${REPORT_DIR}/browser-live-cert.log"

(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  LIVE_LOAD_VIEWERS="${VIEWERS_VALUE}" \
  LIVE_LOAD_SETUP_CONCURRENCY="${SETUP_CONCURRENCY_VALUE}" \
  LIVE_LOAD_CONCURRENCY="${ACTIVE_CONCURRENCY_VALUE}" \
  LIVE_LOAD_SOAK_MINUTES="${SOAK_MINUTES_VALUE}" \
  LIVE_LOAD_PLAYBACK_MODE=live-stream \
  npm --prefix qa-automation run load:live
) | tee "${REPORT_DIR}/live-load.log"

echo "[live-2k-cert] report_dir=${REPORT_DIR}" | tee -a "${REPORT_DIR}/run.log"
