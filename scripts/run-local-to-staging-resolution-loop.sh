#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}"
PROD_SSH_TARGET_VALUE="${PROD_SSH_TARGET:-root@178.105.48.179}"
PROD_REMOTE_DIR_VALUE="${PROD_REMOTE_DIR:-/opt/edumaster}"
PROD_REMOTE_ENV_FILE_VALUE="${PROD_REMOTE_ENV_FILE_PATH:-${PROD_REMOTE_DIR_VALUE}/.env.production}"
STAGING_SSH_TARGET_VALUE="${1:-${STAGING_SSH_TARGET:-}}"
STAGING_IP_VALUE="${2:-${STAGING_IP:-}}"
STAGING_REMOTE_DIR_VALUE="${3:-${STAGING_REMOTE_DIR:-/opt/edumaster-staging}}"
LOCAL_ENV_FILE_VALUE="${LOCAL_ENV_FILE:-${ROOT_DIR}/.env.production}"
STAGING_ENV_FILE_VALUE="${STAGING_ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
LOCAL_POSTGRES_URL_VALUE="${LOCAL_POSTGRES_URL:-postgresql://${USER}@127.0.0.1:15432/edumaster}"
LOCAL_BASE_URL_VALUE="${LOCAL_BASE_URL:-http://127.0.0.1:3300}"
PRODUCTION_BASE_URL_VALUE="${PRODUCTION_BASE_URL:-https://app.varonenglishapp.in}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/local-to-staging-resolution-loop-${RUN_ID}"
LOCAL_BACKUP_PATH="${REPORT_DIR}/production-postgres.sql.gz"
PDF_PACKAGE_DIR="${REPORT_DIR}/targeted-course-pdfs-package"

if [[ -z "${STAGING_SSH_TARGET_VALUE}" || -z "${STAGING_IP_VALUE}" ]]; then
  echo "Usage: $0 <user@staging-host> <staging-ip> [staging-remote-dir]" >&2
  exit 1
fi

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[resolution-loop] target manifest missing: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}"

REMOTE_BACKUP_PATH="$(bash "${ROOT_DIR}/scripts/export-production-postgres-backup.sh" "${PROD_SSH_TARGET_VALUE}")"
ssh "${PROD_SSH_TARGET_VALUE}" "cat '${REMOTE_BACKUP_PATH}'" > "${LOCAL_BACKUP_PATH}"
test -s "${LOCAL_BACKUP_PATH}"

OUTPUT_DIR="${PDF_PACKAGE_DIR}" \
QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
PROD_REMOTE_DIR="${PROD_REMOTE_DIR_VALUE}" \
PROD_REMOTE_ENV_FILE_PATH="${PROD_REMOTE_ENV_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/export-production-targeted-course-pdfs.sh" "${PROD_SSH_TARGET_VALUE}" > "${REPORT_DIR}/targeted-pdf-export-path.txt"

ENV_FILE_PATH="${LOCAL_ENV_FILE_VALUE}" \
LOCAL_POSTGRES_URL="${LOCAL_POSTGRES_URL_VALUE}" \
bash "${ROOT_DIR}/scripts/restore-local-private-mirror.sh" "${LOCAL_BACKUP_PATH}" > "${REPORT_DIR}/local-restore.log" 2>&1

(
  cd "${ROOT_DIR}"
  TARGET_PDF_PACKAGE_DIR="${PDF_PACKAGE_DIR}" \
  TARGET_PRIVATE_UPLOADS_ROOT="${ROOT_DIR}/private_uploads" \
  npm --prefix backend run pdf:import:targets
) > "${REPORT_DIR}/local-pdf-import.log" 2>&1

ENV_FILE="${LOCAL_ENV_FILE_VALUE}" \
LOCAL_POSTGRES_URL="${LOCAL_POSTGRES_URL_VALUE}" \
QA_BASE_URL="${LOCAL_BASE_URL_VALUE}" \
QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/run-local-private-mirror-functional-proof.sh" > "${REPORT_DIR}/localhost-proof.log" 2>&1

RUN_BROWSER_GATE=0 \
ENV_FILE_PATH="${STAGING_ENV_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/deploy-separate-staging-mirror.sh" "${STAGING_SSH_TARGET_VALUE}" "${STAGING_IP_VALUE}" "${STAGING_REMOTE_DIR_VALUE}" > "${REPORT_DIR}/staging-deploy.log" 2>&1

ENV_FILE_PATH="${STAGING_ENV_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/import-targeted-course-pdfs-to-staging.sh" "${STAGING_SSH_TARGET_VALUE}" "${PDF_PACKAGE_DIR}" "${STAGING_REMOTE_DIR_VALUE}" > "${REPORT_DIR}/staging-pdf-import.log" 2>&1

readarray -t staged_targets < <(node - "${TARGETS_FILE_VALUE}" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const entry of payload) {
  process.stdout.write([String(entry.key || ''), String(entry.courseId || ''), String(entry.lessonId || '')].join('\t') + '\n');
}
NODE
)

for target_line in "${staged_targets[@]}"; do
  IFS=$'\t' read -r target_key course_id lesson_id <<< "${target_line}"
  ssh "${STAGING_SSH_TARGET_VALUE}" "\
    cd '${STAGING_REMOTE_DIR_VALUE}' && \
    set -a && . '${STAGING_REMOTE_DIR_VALUE}/$(basename "${STAGING_ENV_FILE_VALUE}")' && set +a && \
    MIGRATE_COURSE_ID='${course_id}' MIGRATE_LESSON_ID='${lesson_id}' MIGRATE_KEEP_STREAM_AS_ROLLBACK=true npm --prefix backend run stream:migrate:private-hls" \
    > "${REPORT_DIR}/staging-migrate-${target_key}.log" 2>&1
done

ENV_FILE="${STAGING_ENV_FILE_VALUE}" \
QA_BASE_URL="https://app.${STAGING_IP_VALUE}.nip.io" \
QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/run-ssc-bank-streaming-pdf-mixed-certification.sh" > "${REPORT_DIR}/staging-certification.log" 2>&1

ENV_FILE="${ROOT_DIR}/.env.production" \
QA_BASE_URL="${PRODUCTION_BASE_URL_VALUE}" \
QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
bash "${ROOT_DIR}/scripts/run-production-targeted-smoke.sh" > "${REPORT_DIR}/production-smoke.log" 2>&1

LOCAL_SUMMARY_PATH="$(find "${ROOT_DIR}/reports" -path '*/targeted-functional-proof-summary.json' -print 2>/dev/null | grep 'targeted-functional-proof-localhost-' | sort | tail -n 1)"
STAGING_SUMMARY_PATH="$(find "${ROOT_DIR}/reports" -path '*/streaming-pdf-mixed-certification-summary.json' -print 2>/dev/null | grep 'streaming-pdf-mixed-certification-' | sort | tail -n 1)"
PRODUCTION_SUMMARY_PATH="$(find "${ROOT_DIR}/reports" -path '*/targeted-functional-proof-summary.json' -print 2>/dev/null | grep 'targeted-functional-proof-production-smoke-' | sort | tail -n 1)"

node - "${REPORT_DIR}/resolution-loop-summary.json" "${TARGETS_FILE_VALUE}" "${LOCAL_SUMMARY_PATH}" "${STAGING_SUMMARY_PATH}" "${PRODUCTION_SUMMARY_PATH}" "${PDF_PACKAGE_DIR}" "${LOCAL_BACKUP_PATH}" <<'NODE'
const fs = require('node:fs');
const [outputPath, targetsFile, localSummaryPath, stagingSummaryPath, productionSummaryPath, pdfPackageDir, backupPath] = process.argv.slice(2);
const summary = {
  ok: true,
  targetsFile,
  backupPath,
  pdfPackageDir,
  localSummaryPath,
  stagingSummaryPath,
  productionSummaryPath,
};
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
NODE
