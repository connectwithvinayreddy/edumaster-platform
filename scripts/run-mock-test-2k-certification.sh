#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
REPORT_SCOPE="${REPORT_SCOPE:-mock-test-2k-cert}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/${REPORT_SCOPE}-${RUN_ID}"
CERT_REPORT_PATH="${REPORT_DIR}/mock-test-certification.json"
GRID_MANIFEST_PATH="${REPORT_DIR}/mock-test-browser-grid-manifest.json"
GRID_REPORT_PATH="${REPORT_DIR}/mock-test-browser-grid-report.json"

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[mock-test-2k-cert] missing env file: ${ENV_FILE_PATH}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}"

set -a
source "${ENV_FILE_PATH}"
set +a

QA_BASE_URL_VALUE="${QA_BASE_URL:-${APP_URL:-}}"
if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "[mock-test-2k-cert] QA_BASE_URL or APP_URL is required." >&2
  exit 1
fi

echo "[mock-test-2k-cert] env=${ENV_FILE_PATH}" | tee "${REPORT_DIR}/run.log"
echo "[mock-test-2k-cert] base_url=${QA_BASE_URL_VALUE}" | tee -a "${REPORT_DIR}/run.log"

(
  cd "${ROOT_DIR}"
  MOCK_TEST_CERT_MODE="${MOCK_TEST_CERT_MODE:-certify}" \
  MOCK_TEST_CERT_OUTPUT_PATH="${CERT_REPORT_PATH}" \
  MOCK_TEST_BROWSER_GRID_MANIFEST_PATH="${GRID_MANIFEST_PATH}" \
  node backend/mock-test-submit-load-test.js
) | tee "${REPORT_DIR}/mock-test-load.log"

eval "$(
  node - "${CERT_REPORT_PATH}" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const proof = report.browserProof || {};
const lines = [
  `QA_TEST_TITLE=${JSON.stringify(String(proof.title || ''))}`,
  `QA_MANUAL_EMAIL=${JSON.stringify(String(proof.manualStudentEmail || ''))}`,
  `QA_PAUSE_EMAIL=${JSON.stringify(String(proof.pauseStudentEmail || ''))}`,
  `QA_TIMEOUT_EMAIL=${JSON.stringify(String(proof.timeoutStudentEmail || ''))}`,
  `QA_TEST_PASSWORD=${JSON.stringify(String(proof.studentPassword || 'Student@123'))}`,
  `QA_GRID_TEST_TITLE=${JSON.stringify(String(report.browserGrid?.title || ''))}`,
  `QA_GRID_TEST_ID=${JSON.stringify(String(report.browserGrid?.testId || ''))}`,
  `QA_GRID_MANIFEST_PATH=${JSON.stringify(String(report.browserGrid?.manifestPath || ''))}`,
  `QA_GRID_TOTAL_USERS=${JSON.stringify(String(report.browserGrid?.totalUsers || '0'))}`,
];
process.stdout.write(lines.join('\n'));
NODE
)"

if [[ -z "${QA_TEST_TITLE}" || -z "${QA_MANUAL_EMAIL}" || -z "${QA_PAUSE_EMAIL}" || -z "${QA_TIMEOUT_EMAIL}" || -z "${QA_GRID_MANIFEST_PATH}" ]]; then
  echo "[mock-test-2k-cert] missing browser proof data in ${CERT_REPORT_PATH}" >&2
  exit 1
fi

(
  cd "${ROOT_DIR}"
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_MOCK_TEST_GRID_MANIFEST_PATH="${QA_GRID_MANIFEST_PATH}" \
  QA_MOCK_TEST_GRID_REPORT_PATH="${GRID_REPORT_PATH}" \
  QA_MOCK_TEST_GRID_WORKER_COUNT="${QA_MOCK_TEST_GRID_WORKER_COUNT:-20}" \
  QA_MOCK_TEST_GRID_BROWSERS_PER_WORKER="${QA_MOCK_TEST_GRID_BROWSERS_PER_WORKER:-10}" \
  QA_MOCK_TEST_GRID_SCREENSHOT_SAMPLE="${QA_MOCK_TEST_GRID_SCREENSHOT_SAMPLE:-12}" \
  QA_MOCK_TEST_GRID_START_STAGGER_MS="${QA_MOCK_TEST_GRID_START_STAGGER_MS:-150}" \
  QA_MOCK_TEST_GRID_LOCAL_RUN="${QA_MOCK_TEST_GRID_LOCAL_RUN:-false}" \
  npm --prefix qa-automation run browser:mock-test-grid-cert
) | tee "${REPORT_DIR}/browser-grid.log"

(
  cd "${ROOT_DIR}"
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_LOGIN_EMAIL="${QA_MANUAL_EMAIL}" \
  QA_LOGIN_PASSWORD="${QA_TEST_PASSWORD}" \
  QA_TEST_TITLE="${QA_TEST_TITLE}" \
  QA_TEST_CERTIFICATION_MODE=true \
  QA_TEST_EXPECTED_QUESTIONS=120 \
  QA_TEST_EXPECTED_DURATION_MINUTES=120 \
  npm --prefix qa-automation run browser:tests
) | tee "${REPORT_DIR}/browser-tests.log"

(
  cd "${ROOT_DIR}"
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_LOGIN_EMAIL="${QA_PAUSE_EMAIL}" \
  QA_LOGIN_PASSWORD="${QA_TEST_PASSWORD}" \
  QA_TEST_TITLE="${QA_TEST_TITLE}" \
  npm --prefix qa-automation run browser:tests-pause
) | tee "${REPORT_DIR}/browser-tests-pause.log"

(
  cd "${ROOT_DIR}"
  QA_BASE_URL="${QA_BASE_URL_VALUE}" \
  QA_LOGIN_EMAIL="${QA_TIMEOUT_EMAIL}" \
  QA_LOGIN_PASSWORD="${QA_TEST_PASSWORD}" \
  QA_TEST_TITLE="${QA_TEST_TITLE}" \
  QA_TEST_CERTIFICATION_MODE=true \
  QA_TEST_EXPECTED_QUESTIONS=120 \
  QA_TEST_EXPECTED_DURATION_MINUTES=120 \
  QA_TEST_AUTO_SUBMIT_SECONDS="${QA_TEST_AUTO_SUBMIT_SECONDS:-3}" \
  QA_TEST_SKIP_MOBILE=true \
  npm --prefix qa-automation run browser:tests
) | tee "${REPORT_DIR}/browser-tests-timeout.log"

echo "[mock-test-2k-cert] report_dir=${REPORT_DIR}" | tee -a "${REPORT_DIR}/run.log"
