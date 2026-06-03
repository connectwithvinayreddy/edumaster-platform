#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
QA_BASE_URL_VALUE="${QA_BASE_URL:-}"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}"

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[stream-cert] missing env file: ${ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[stream-cert] missing target manifest: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  APP_URL_VALUE="$(grep -E '^APP_URL=' "${ENV_FILE_PATH}" | tail -n 1 | cut -d= -f2- || true)"
  QA_BASE_URL_VALUE="${APP_URL_VALUE}"
fi

if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "[stream-cert] QA_BASE_URL is required, either via env or APP_URL in ${ENV_FILE_PATH}" >&2
  exit 1
fi

(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
  QA_STREAM_CERT_BROWSER_STAGES="${QA_STREAM_CERT_BROWSER_STAGES:-100,200}" \
  QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES="${QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES:-1000,2000}" \
  QA_STREAM_CERT_SYNTHETIC_VIDEO_PERCENT="${QA_STREAM_CERT_SYNTHETIC_VIDEO_PERCENT:-70}" \
  QA_STREAM_CERT_SYNTHETIC_PDF_PERCENT="${QA_STREAM_CERT_SYNTHETIC_PDF_PERCENT:-16}" \
  QA_STREAM_CERT_SYNTHETIC_AUTH_PERCENT="${QA_STREAM_CERT_SYNTHETIC_AUTH_PERCENT:-4}" \
  QA_STREAM_CERT_SYNTHETIC_TEST_PERCENT="${QA_STREAM_CERT_SYNTHETIC_TEST_PERCENT:-10}" \
  npm --prefix qa-automation run cert:streaming-pdf-mixed
)
