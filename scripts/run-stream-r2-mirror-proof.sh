#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_PROOF_SUMMARY_PATH="${LOCAL_PROOF_SUMMARY:-${ROOT_DIR}/reports/stream-r2-proof/latest/local-proof.json}"
STAGING_SSH_TARGET="${1:-${STAGING_SSH_TARGET:-}}"
STAGING_IP_VALUE="${2:-${STAGING_IP:-}}"
STAGING_REMOTE_DIR="${3:-${STAGING_REMOTE_DIR:-/opt/edumaster-staging}}"
ENV_FILE_PATH="${ENV_FILE_PATH:-${ROOT_DIR}/.env.staging.private-mirror}"
REMOTE_ENV_FILE_PATH="${REMOTE_ENV_FILE_PATH:-${STAGING_REMOTE_DIR}/$(basename "${ENV_FILE_PATH}")}"
PREPARE_STAGING_MIRROR_VALUE="${PREPARE_STAGING_MIRROR:-1}"
STAGING_BASE_URL="${QA_BASE_URL:-https://app.${STAGING_IP_VALUE}.nip.io}"
REPORT_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/stream-r2-mirror-proof-${REPORT_ID}"
PROOF_LATEST_DIR="${ROOT_DIR}/reports/stream-r2-proof/latest"
MANIFEST_PATH="${REPORT_DIR}/prepared-browser-users.json"
USER_PASSWORD_VALUE="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}"
QA_VIDEO_BROWSER_STAGES_VALUE="${QA_VIDEO_BROWSER_STAGES:-1,3,10,15,25,50,100}"

latest_rootcause_summary() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-playback-rootcause.json' -print 2>/dev/null | sort | tail -n 1
}

latest_watch_limit_report() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/report.json' -print 2>/dev/null | grep 'course-watch-limit-regression-' | sort | tail -n 1
}

latest_browser_concurrency_summary() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-video-browser-concurrency-summary.json' -print 2>/dev/null | sort | tail -n 1
}

remote_with_env() {
  local log_path="$1"
  shift
  ssh "${STAGING_SSH_TARGET}" "cd '${STAGING_REMOTE_DIR}' && set -a && . '${REMOTE_ENV_FILE_PATH}' && set +a && $*" > "${log_path}" 2>&1
}

if [[ ! -f "${LOCAL_PROOF_SUMMARY_PATH}" ]]; then
  echo "[mirror-proof] missing local proof summary: ${LOCAL_PROOF_SUMMARY_PATH}" >&2
  exit 1
fi

if [[ -z "${STAGING_SSH_TARGET}" || -z "${STAGING_IP_VALUE}" ]]; then
  echo "Usage: $0 <user@staging-host> <staging-ip> [remote-dir]" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[mirror-proof] missing staging env file: ${ENV_FILE_PATH}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}" "${PROOF_LATEST_DIR}"

readarray -t local_proof_fields < <(node - "${LOCAL_PROOF_SUMMARY_PATH}" <<'NODE'
const fs = require('node:fs');
const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!summary?.ok) {
  throw new Error('local proof summary is not marked ok');
}
process.stdout.write([
  String(summary.courseId || ''),
  String(summary.lessonId || ''),
  String(summary.courseText || ''),
  String(summary.lessonText || ''),
].join('\n'));
NODE
)

COURSE_ID_VALUE="${local_proof_fields[0]:-}"
LESSON_ID_VALUE="${local_proof_fields[1]:-}"
COURSE_TEXT_VALUE="${local_proof_fields[2]:-}"
LESSON_TEXT_VALUE="${local_proof_fields[3]:-}"

if [[ -z "${COURSE_ID_VALUE}" || -z "${LESSON_ID_VALUE}" ]]; then
  echo "[mirror-proof] local proof summary did not include courseId/lessonId." >&2
  exit 1
fi

echo "[mirror-proof] using local proof candidate ${COURSE_ID_VALUE}/${LESSON_ID_VALUE}" | tee "${REPORT_DIR}/steps.log"

if [[ "${PREPARE_STAGING_MIRROR_VALUE}" == "1" ]]; then
  echo "[mirror-proof] preparing staging/private mirror" | tee -a "${REPORT_DIR}/steps.log"
  RUN_BROWSER_GATE=0 ENV_FILE_PATH="${ENV_FILE_PATH}" \
    bash "${ROOT_DIR}/scripts/deploy-separate-staging-mirror.sh" "${STAGING_SSH_TARGET}" "${STAGING_IP_VALUE}" "${STAGING_REMOTE_DIR}" \
    > "${REPORT_DIR}/deploy-staging-mirror.log" 2>&1
fi

echo "[mirror-proof] checking staging mirror health" | tee -a "${REPORT_DIR}/steps.log"
bash "${ROOT_DIR}/scripts/check-staging-private-mirror-health.sh" "${STAGING_BASE_URL}" > "${REPORT_DIR}/staging-health.log" 2>&1

echo "[mirror-proof] migrating single lesson on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
remote_with_env "${REPORT_DIR}/remote-single-lesson-migrate.log" \
  "MIGRATE_COURSE_ID='${COURSE_ID_VALUE}' MIGRATE_LESSON_ID='${LESSON_ID_VALUE}' MIGRATE_KEEP_STREAM_AS_ROLLBACK=true npm --prefix backend run stream:migrate:private-hls"

echo "[mirror-proof] preparing one QA browser user on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_VIDEO_BROWSER_MANIFEST_USERS=1 \
  QA_VIDEO_BROWSER_MANIFEST_PATH="${MANIFEST_PATH}" \
  PLATFORM_LOAD_USER_PASSWORD="${USER_PASSWORD_VALUE}" \
  npm --prefix qa-automation run browser:prepare-video-browser-manifest
) > "${REPORT_DIR}/prepare-browser-user.log" 2>&1

readarray -t prepared_user < <(node - "${MANIFEST_PATH}" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const user = payload[0];
if (!user) {
  process.exit(1);
}
process.stdout.write([
  String(user.email || ''),
].join('\n'));
NODE
)

QA_USER_EMAIL="${prepared_user[0]:-}"
if [[ -z "${QA_USER_EMAIL}" ]]; then
  echo "[mirror-proof] failed to prepare a staging QA browser user." >&2
  exit 1
fi

echo "[mirror-proof] running desktop root-cause proof on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL}" \
  QA_LOGIN_EMAIL="${QA_USER_EMAIL}" \
  QA_LOGIN_PASSWORD="${USER_PASSWORD_VALUE}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
) > "${REPORT_DIR}/single-lesson-desktop-rootcause.log" 2>&1
SINGLE_DESKTOP_SUMMARY_PATH="$(latest_rootcause_summary)"

echo "[mirror-proof] running mobile root-cause proof on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL}" \
  QA_LOGIN_EMAIL="${QA_USER_EMAIL}" \
  QA_LOGIN_PASSWORD="${USER_PASSWORD_VALUE}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  QA_MOBILE_MODE=true \
  npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
) > "${REPORT_DIR}/single-lesson-mobile-rootcause.log" 2>&1
SINGLE_MOBILE_SUMMARY_PATH="$(latest_rootcause_summary)"

echo "[mirror-proof] running watch-limit regression on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL}" \
  QA_LOGIN_PASSWORD="${USER_PASSWORD_VALUE}" \
  QA_WATCH_LIMIT_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_WATCH_LIMIT_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_WATCH_LIMIT_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_WATCH_LIMIT_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  QA_AUTOMATION_CLEANUP_MODE=execute \
  npm --prefix qa-automation run browser:video-false-completion-after-pause-powercut-regression
) > "${REPORT_DIR}/single-lesson-watch-limit.log" 2>&1
SINGLE_WATCH_LIMIT_REPORT_PATH="$(latest_watch_limit_report)"

echo "[mirror-proof] migrating the full parent course on staging mirror" | tee -a "${REPORT_DIR}/steps.log"
remote_with_env "${REPORT_DIR}/remote-full-course-migrate.log" \
  "MIGRATE_COURSE_ID='${COURSE_ID_VALUE}' MIGRATE_KEEP_STREAM_AS_ROLLBACK=true npm --prefix backend run stream:migrate:private-hls"

echo "[mirror-proof] running the full staging proof gate through 100 viewers" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  QA_WATCH_LIMIT_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_WATCH_LIMIT_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_WATCH_LIMIT_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_WATCH_LIMIT_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  QA_VIDEO_BROWSER_STAGES="${QA_VIDEO_BROWSER_STAGES_VALUE}" \
  RUN_WATCH_LIMIT=1 \
  bash ./scripts/run-staging-private-mirror-gate.sh
) > "${REPORT_DIR}/staging-gate.log" 2>&1

FULL_GATE_SUMMARY_PATH="$(find "${ROOT_DIR}/reports" -path '*/gate-summary.json' -print 2>/dev/null | grep 'staging-private-mirror-gate-' | sort | tail -n 1)"
FULL_BROWSER_SUMMARY_PATH="$(latest_browser_concurrency_summary)"
FULL_ROOTCAUSE_SUMMARY_PATH="$(latest_rootcause_summary)"
FULL_WATCH_LIMIT_REPORT_PATH="$(latest_watch_limit_report)"

node - "${SINGLE_DESKTOP_SUMMARY_PATH}" "${SINGLE_MOBILE_SUMMARY_PATH}" "${FULL_BROWSER_SUMMARY_PATH}" <<'NODE'
const fs = require('node:fs');
const [desktopPath, mobilePath, browserPath] = process.argv.slice(2);

for (const filePath of [desktopPath, mobilePath]) {
  const summary = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!summary.ok) {
    throw new Error(`root-cause summary failed: ${filePath}`);
  }
  if (summary.deliveryPath !== 'protected_hls_gateway') {
    throw new Error(`unexpected deliveryPath ${summary.deliveryPath} in ${filePath}`);
  }
}

const browserSummary = JSON.parse(fs.readFileSync(browserPath, 'utf8'));
if (!browserSummary.overallOk) {
  throw new Error(`browser ladder failed: ${browserPath}`);
}
if (Number(browserSummary.realBrowserUsers || 0) < 100) {
  throw new Error(`browser ladder did not reach 100 viewers: ${browserSummary.realBrowserUsers || 0}`);
}
NODE

MIRROR_PROOF_SUMMARY_PATH="${REPORT_DIR}/mirror-proof-summary.json"
node - "${MIRROR_PROOF_SUMMARY_PATH}" "${STAGING_BASE_URL}" "${ENV_FILE_PATH}" "${LOCAL_PROOF_SUMMARY_PATH}" "${COURSE_ID_VALUE}" "${LESSON_ID_VALUE}" "${COURSE_TEXT_VALUE}" "${LESSON_TEXT_VALUE}" "${SINGLE_DESKTOP_SUMMARY_PATH}" "${SINGLE_MOBILE_SUMMARY_PATH}" "${SINGLE_WATCH_LIMIT_REPORT_PATH}" "${FULL_GATE_SUMMARY_PATH}" "${FULL_ROOTCAUSE_SUMMARY_PATH}" "${FULL_WATCH_LIMIT_REPORT_PATH}" "${FULL_BROWSER_SUMMARY_PATH}" "${REPORT_DIR}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  baseUrl,
  envFile,
  localProofPath,
  courseId,
  lessonId,
  courseText,
  lessonText,
  singleDesktopSummaryPath,
  singleMobileSummaryPath,
  singleWatchLimitReportPath,
  fullGateSummaryPath,
  fullRootcauseSummaryPath,
  fullWatchLimitReportPath,
  fullBrowserSummaryPath,
  reportDir,
] = process.argv.slice(2);

const browserSummary = JSON.parse(fs.readFileSync(fullBrowserSummaryPath, 'utf8'));

fs.writeFileSync(outputPath, JSON.stringify({
  ok: true,
  readyForProductionDeploy: true,
  baseUrl,
  envFile,
  localProofPath,
  courseId,
  lessonId,
  courseText,
  lessonText,
  singleLesson: {
    desktopSummaryPath: singleDesktopSummaryPath,
    mobileSummaryPath: singleMobileSummaryPath,
    watchLimitReportPath: singleWatchLimitReportPath,
  },
  fullCourse: {
    gateSummaryPath: fullGateSummaryPath,
    rootcauseSummaryPath: fullRootcauseSummaryPath,
    watchLimitReportPath: fullWatchLimitReportPath,
    browserSummaryPath: fullBrowserSummaryPath,
    maxViewerStagePassed: Number(browserSummary.realBrowserUsers || 0),
  },
  reportDir,
}, null, 2));
NODE

cp "${MIRROR_PROOF_SUMMARY_PATH}" "${PROOF_LATEST_DIR}/mirror-proof.json"
cp "${MIRROR_PROOF_SUMMARY_PATH}" "${PROOF_LATEST_DIR}/production-deploy-ready.json"
echo "[mirror-proof] complete: ${MIRROR_PROOF_SUMMARY_PATH}"
