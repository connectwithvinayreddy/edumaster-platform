#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-3300}"
LOCAL_BASE_URL="${QA_BASE_URL:-http://${LOCAL_HOST}:${LOCAL_PORT}}"
START_LOCAL_APP_VALUE="${START_LOCAL_APP:-1}"
REPORT_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/stream-r2-local-proof-${REPORT_ID}"
PROOF_LATEST_DIR="${ROOT_DIR}/reports/stream-r2-proof/latest"
MANIFEST_PATH="${REPORT_DIR}/prepared-browser-users.json"
APP_LOG_PATH="${REPORT_DIR}/local-app.log"
MIGRATION_DRY_RUN_LOG="${REPORT_DIR}/migration-dry-run.log"
MIGRATION_REAL_LOG="${REPORT_DIR}/migration-real.log"
PLAYER_PROBE_PATH="${REPORT_DIR}/player-probe.json"
CANDIDATES_PATH="${REPORT_DIR}/stream-candidates.json"
USER_PASSWORD_VALUE="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}"

local_app_pid=""

cleanup() {
  if [[ -n "${local_app_pid}" ]] && kill -0 "${local_app_pid}" 2>/dev/null; then
    kill "${local_app_pid}" 2>/dev/null || true
    wait "${local_app_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

latest_rootcause_summary() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-playback-rootcause.json' -print 2>/dev/null | sort | tail -n 1
}

wait_for_endpoint() {
  local url="$1"
  local timeout_seconds="${2:-120}"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    local status
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" || true)"
    if [[ "${status}" =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi
    sleep 2
  done
  echo "[local-proof] timed out waiting for ${url}" >&2
  return 1
}

if [[ ! -f "${ENV_FILE_PATH}" ]]; then
  echo "[local-proof] missing env file: ${ENV_FILE_PATH}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}" "${PROOF_LATEST_DIR}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE_PATH}"
set +a

export NODE_ENV=development
export HOST="${LOCAL_HOST}"
export PORT="${LOCAL_PORT}"
export APP_URL="${LOCAL_BASE_URL}"
export VITE_PUBLIC_APP_URL="${LOCAL_BASE_URL}"
export VITE_API_BASE_URL="${LOCAL_BASE_URL}/backend/api"
export CORS_ORIGIN="${LOCAL_BASE_URL},http://localhost,capacitor://localhost,ionic://localhost"

if ! curl -f -sS -o /dev/null --max-time 5 "${LOCAL_BASE_URL}/backend/api/health"; then
  if [[ "${START_LOCAL_APP_VALUE}" != "1" ]]; then
    echo "[local-proof] ${LOCAL_BASE_URL} is not up and START_LOCAL_APP=1 was not provided." >&2
    exit 1
  fi

  echo "[local-proof] starting local app on ${LOCAL_BASE_URL}" | tee "${REPORT_DIR}/steps.log"
  (
    cd "${ROOT_DIR}"
    npm run dev:app
  ) >"${APP_LOG_PATH}" 2>&1 &
  local_app_pid=$!
fi

wait_for_endpoint "${LOCAL_BASE_URL}/" 180
wait_for_endpoint "${LOCAL_BASE_URL}/backend/api/live" 180
wait_for_endpoint "${LOCAL_BASE_URL}/backend/api/ready" 180
wait_for_endpoint "${LOCAL_BASE_URL}/backend/api/health" 180

echo "[local-proof] discovering Stream-backed candidate lesson" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  MIGRATE_COURSE_ID="${MIGRATE_COURSE_ID:-}" \
  MIGRATE_LESSON_ID="${MIGRATE_LESSON_ID:-}" \
  MIGRATE_MAX_LESSONS=25 \
  node backend/scripts/list-cloudflare-stream-lessons.mjs
) > "${CANDIDATES_PATH}"

readarray -t candidate_fields < <(node - "${CANDIDATES_PATH}" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const candidate = payload.firstCandidate;
if (!candidate) {
  process.exit(1);
}
process.stdout.write([
  String(candidate.courseId || ''),
  String(candidate.lessonId || ''),
  String(candidate.courseTitle || ''),
  String(candidate.lessonTitle || ''),
].join('\n'));
NODE
)

if [[ "${#candidate_fields[@]}" -lt 4 ]]; then
  echo "[local-proof] no Stream-backed lesson candidate was found." >&2
  exit 1
fi

COURSE_ID_VALUE="${candidate_fields[0]}"
LESSON_ID_VALUE="${candidate_fields[1]}"
COURSE_TEXT_VALUE="${candidate_fields[2]}"
LESSON_TEXT_VALUE="${candidate_fields[3]}"

echo "[local-proof] candidate ${COURSE_ID_VALUE}/${LESSON_ID_VALUE} (${COURSE_TEXT_VALUE} / ${LESSON_TEXT_VALUE})" | tee -a "${REPORT_DIR}/steps.log"

echo "[local-proof] preparing one QA browser user" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${LOCAL_BASE_URL}" \
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
  String(user.token || ''),
].join('\n'));
NODE
)

QA_USER_EMAIL="${prepared_user[0]:-}"
QA_USER_TOKEN="${prepared_user[1]:-}"
if [[ -z "${QA_USER_EMAIL}" || -z "${QA_USER_TOKEN}" ]]; then
  echo "[local-proof] failed to prepare QA browser user manifest." >&2
  exit 1
fi

echo "[local-proof] running migration dry-run" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  MIGRATE_COURSE_ID="${COURSE_ID_VALUE}" \
  MIGRATE_LESSON_ID="${LESSON_ID_VALUE}" \
  MIGRATE_DRY_RUN=1 \
  MIGRATE_KEEP_STREAM_AS_ROLLBACK=true \
  npm --prefix backend run stream:migrate:private-hls
) > "${MIGRATION_DRY_RUN_LOG}" 2>&1

echo "[local-proof] running real migration" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  MIGRATE_COURSE_ID="${COURSE_ID_VALUE}" \
  MIGRATE_LESSON_ID="${LESSON_ID_VALUE}" \
  MIGRATE_KEEP_STREAM_AS_ROLLBACK=true \
  npm --prefix backend run stream:migrate:private-hls
) > "${MIGRATION_REAL_LOG}" 2>&1

echo "[local-proof] probing /player after migration" | tee -a "${REPORT_DIR}/steps.log"
node - "${PLAYER_PROBE_PATH}" "${LOCAL_BASE_URL}" "${COURSE_ID_VALUE}" "${LESSON_ID_VALUE}" "${QA_USER_TOKEN}" <<'NODE'
const fs = require('node:fs');

const outputPath = process.argv[2];
const baseUrl = process.argv[3];
const courseId = process.argv[4];
const lessonId = process.argv[5];
const token = process.argv[6];

const main = async () => {
  const response = await fetch(`${baseUrl}/backend/api/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/player`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-edumaster-app': 'web',
      'x-edumaster-client-platform': 'windows',
      'x-edumaster-client-browser': 'edge',
      'x-edumaster-device-id': 'qa-stream-r2-local-proof-device',
      'x-edumaster-playback-tab-id': 'qa-stream-r2-local-proof-tab',
      'x-edumaster-browser-tab-id': 'qa-stream-r2-local-proof-tab',
    },
  });
  const payload = await response.json().catch(() => ({}));
  fs.writeFileSync(outputPath, JSON.stringify({
    status: response.status,
    ok: response.ok,
    payload,
  }, null, 2));
  const raw = JSON.stringify(payload);
  if (!response.ok) {
    throw new Error(`player probe failed with ${response.status}`);
  }
  if (/cloudflarestream\.com|videodelivery\.net/i.test(raw)) {
    throw new Error('player probe still references Cloudflare Stream');
  }
  if (!/course-manifests|\.m3u8/i.test(raw)) {
    throw new Error('player probe did not resolve to protected HLS output');
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
NODE

echo "[local-proof] running desktop root-cause playback proof" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${LOCAL_BASE_URL}" \
  QA_LOGIN_EMAIL="${QA_USER_EMAIL}" \
  QA_LOGIN_PASSWORD="${USER_PASSWORD_VALUE}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
) > "${REPORT_DIR}/desktop-rootcause.log" 2>&1
DESKTOP_SUMMARY_PATH="$(latest_rootcause_summary)"

echo "[local-proof] running mobile root-cause playback proof" | tee -a "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${ENV_FILE_PATH}" \
  QA_BASE_URL="${LOCAL_BASE_URL}" \
  QA_LOGIN_EMAIL="${QA_USER_EMAIL}" \
  QA_LOGIN_PASSWORD="${USER_PASSWORD_VALUE}" \
  QA_COURSE_ID="${COURSE_ID_VALUE}" \
  QA_LESSON_ID="${LESSON_ID_VALUE}" \
  QA_COURSE_TEXT="${COURSE_TEXT_VALUE}" \
  QA_LESSON_TEXT="${LESSON_TEXT_VALUE}" \
  QA_MOBILE_MODE=true \
  npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
) > "${REPORT_DIR}/mobile-rootcause.log" 2>&1
MOBILE_SUMMARY_PATH="$(latest_rootcause_summary)"

node - "${DESKTOP_SUMMARY_PATH}" "${MOBILE_SUMMARY_PATH}" <<'NODE'
const fs = require('node:fs');

for (const filePath of process.argv.slice(2)) {
  const summary = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!summary.ok) {
    throw new Error(`root-cause summary failed: ${filePath}`);
  }
  if (summary.deliveryPath !== 'protected_hls_gateway') {
    throw new Error(`unexpected deliveryPath ${summary.deliveryPath} in ${filePath}`);
  }
  const responseUrls = Array.isArray(summary.responses) ? summary.responses.map((entry) => String(entry.url || '')) : [];
  if (responseUrls.some((url) => /cloudflarestream\.com|videodelivery\.net/i.test(url))) {
    throw new Error(`root-cause network still contains Cloudflare Stream URLs in ${filePath}`);
  }
}
NODE

LOCAL_PROOF_SUMMARY_PATH="${REPORT_DIR}/local-proof-summary.json"
node - "${LOCAL_PROOF_SUMMARY_PATH}" "${LOCAL_BASE_URL}" "${ENV_FILE_PATH}" "${COURSE_ID_VALUE}" "${LESSON_ID_VALUE}" "${COURSE_TEXT_VALUE}" "${LESSON_TEXT_VALUE}" "${QA_USER_EMAIL}" "${CANDIDATES_PATH}" "${PLAYER_PROBE_PATH}" "${DESKTOP_SUMMARY_PATH}" "${MOBILE_SUMMARY_PATH}" "${REPORT_DIR}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  baseUrl,
  envFile,
  courseId,
  lessonId,
  courseText,
  lessonText,
  qaUserEmail,
  candidateDiscoveryPath,
  playerProbePath,
  desktopSummaryPath,
  mobileSummaryPath,
  reportDir,
] = process.argv.slice(2);

fs.writeFileSync(outputPath, JSON.stringify({
  ok: true,
  baseUrl,
  envFile,
  courseId,
  lessonId,
  courseText,
  lessonText,
  qaUserEmail,
  candidateDiscoveryPath,
  playerProbePath,
  desktopSummaryPath,
  mobileSummaryPath,
  reportDir,
}, null, 2));
NODE

cp "${LOCAL_PROOF_SUMMARY_PATH}" "${PROOF_LATEST_DIR}/local-proof.json"
echo "[local-proof] complete: ${LOCAL_PROOF_SUMMARY_PATH}"
