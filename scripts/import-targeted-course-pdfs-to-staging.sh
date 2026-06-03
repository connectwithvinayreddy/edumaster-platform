#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_SSH_TARGET="${1:-${STAGING_SSH_TARGET:-}}"
PACKAGE_DIR="${2:-${TARGET_PDF_PACKAGE_DIR:-}}"
STAGING_REMOTE_DIR="${3:-${STAGING_REMOTE_DIR:-/opt/edumaster-staging}}"
ENV_FILE_PATH="${ENV_FILE_PATH:-${ROOT_DIR}/.env.staging.private-mirror}"
REMOTE_ENV_FILE_PATH="${REMOTE_ENV_FILE_PATH:-${STAGING_REMOTE_DIR}/$(basename "${ENV_FILE_PATH}")}"
REMOTE_TMP_ROOT="${STAGING_REMOTE_DIR}/tmp/targeted-course-pdfs-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
REMOTE_PACKAGE_DIR="${REMOTE_TMP_ROOT}/package"

if [[ -z "${STAGING_SSH_TARGET}" || -z "${PACKAGE_DIR}" ]]; then
  echo "Usage: $0 <user@staging-host> /absolute/path/to/targeted-pdf-package-dir [remote-dir]" >&2
  exit 1
fi

if [[ ! -d "${PACKAGE_DIR}" ]]; then
  echo "[staging-pdf-import] package directory missing: ${PACKAGE_DIR}" >&2
  exit 1
fi

ssh "${STAGING_SSH_TARGET}" "mkdir -p '${REMOTE_PACKAGE_DIR}'"
tar -C "${PACKAGE_DIR}" -czf - . | ssh "${STAGING_SSH_TARGET}" "tar -xzf - -C '${REMOTE_PACKAGE_DIR}'"
ssh "${STAGING_SSH_TARGET}" "cd '${STAGING_REMOTE_DIR}' && ENV_FILE='${REMOTE_ENV_FILE_PATH}' bash ./infra/lowcost/import-staging-private-pdf-package.sh '${REMOTE_PACKAGE_DIR}'"
ssh "${STAGING_SSH_TARGET}" "rm -rf '${REMOTE_TMP_ROOT}'"
