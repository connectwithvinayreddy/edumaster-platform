#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD_SSH_TARGET="${1:-${PROD_SSH_TARGET:-root@178.105.48.179}}"
PROD_REMOTE_DIR="${PROD_REMOTE_DIR:-/opt/edumaster}"
PROD_REMOTE_ENV_FILE_PATH="${PROD_REMOTE_ENV_FILE_PATH:-${PROD_REMOTE_DIR}/.env.production}"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}}"
OUTPUT_DIR_VALUE="${OUTPUT_DIR:-${TARGET_PDF_PACKAGE_DIR:-${ROOT_DIR}/reports/targeted-course-pdfs-package}}"
REMOTE_TMP_ROOT="${PROD_REMOTE_DIR}/tmp/targeted-course-pdfs-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
REMOTE_TARGETS_FILE_PATH="${REMOTE_TMP_ROOT}/targets.json"
REMOTE_PACKAGE_DIR="${REMOTE_TMP_ROOT}/package"

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[export-targeted-pdfs] target manifest missing: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR_VALUE}"
ssh "${PROD_SSH_TARGET}" "mkdir -p '${REMOTE_TMP_ROOT}'"
cat "${TARGETS_FILE_VALUE}" | ssh "${PROD_SSH_TARGET}" "cat > '${REMOTE_TARGETS_FILE_PATH}'"

ssh "${PROD_SSH_TARGET}" "\
  cd '${PROD_REMOTE_DIR}' && \
  set -a && . '${PROD_REMOTE_ENV_FILE_PATH}' && set +a && \
  QA_STREAM_CERT_TARGETS_FILE='${REMOTE_TARGETS_FILE_PATH}' \
  TARGET_PDF_PACKAGE_DIR='${REMOTE_PACKAGE_DIR}' \
  npm --prefix backend run pdf:export:targets >/tmp/targeted-course-pdfs-export.log"

ssh "${PROD_SSH_TARGET}" "tar -C '${REMOTE_PACKAGE_DIR}' -czf - ." | tar -xzf - -C "${OUTPUT_DIR_VALUE}"
ssh "${PROD_SSH_TARGET}" "rm -rf '${REMOTE_TMP_ROOT}'"

echo "${OUTPUT_DIR_VALUE}"
