#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_ENV_FILE_PATH="${ENV_FILE:-${STAGING_ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}}"
PRODUCTION_ENV_FILE_PATH="${PRODUCTION_ENV_FILE:-${ROOT_DIR}/.env.production}"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}"
STAGING_BASE_URL_VALUE="${QA_BASE_URL:-${STAGING_BASE_URL:-}}"
PRODUCTION_BASE_URL_VALUE="${PRODUCTION_QA_BASE_URL:-https://app.varonenglishapp.in}"
STAGING_BROWSER_STAGES_VALUE="${STAGING_BROWSER_STAGES:-1,3,10,25,50,100,250,500,1000,2000}"
PROOF_SCOPE_VALUE="${PROOF_SCOPE:-staging-emergency}"
DEPLOY_PRODUCTION_VALUE="${DEPLOY_PRODUCTION:-0}"
RUN_PRODUCTION_SMOKE_VALUE="${RUN_PRODUCTION_SMOKE:-1}"
CAPTURE_MID_STREAM_VALUE="${QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS:-true}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/emergency-protected-hls-rollout-${RUN_ID}"
SUMMARY_JSONL="${REPORT_DIR}/browser-gates.jsonl"

mkdir -p "${REPORT_DIR}"

if [[ ! -f "${STAGING_ENV_FILE_PATH}" ]]; then
  echo "[emergency-rollout] missing staging env file: ${STAGING_ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${PRODUCTION_ENV_FILE_PATH}" ]]; then
  echo "[emergency-rollout] missing production env file: ${PRODUCTION_ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[emergency-rollout] missing target manifest: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

if [[ -z "${STAGING_BASE_URL_VALUE}" ]]; then
  STAGING_BASE_URL_VALUE="$(grep -E '^APP_URL=' "${STAGING_ENV_FILE_PATH}" | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ -z "${STAGING_BASE_URL_VALUE}" ]]; then
  echo "[emergency-rollout] STAGING_BASE_URL or QA_BASE_URL is required." >&2
  exit 1
fi

readarray -t encoded_targets < <(node - "${TARGETS_FILE_VALUE}" "${QA_STREAM_CERT_TARGET_KEY:-}" "${QA_STREAM_CERT_TARGET_INDEX:-}" <<'NODE'
const fs = require('node:fs');
const [targetsPath, requestedKey, requestedIndex] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
let targets = payload;
if (requestedKey) {
  targets = payload.filter((entry) => String(entry.key || '').trim() === String(requestedKey).trim());
  if (!targets.length) {
    throw new Error(`Target key not found: ${requestedKey}`);
  }
} else if (requestedIndex) {
  const index = Number(requestedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= payload.length) {
    throw new Error(`Target index out of range: ${requestedIndex}`);
  }
  targets = [payload[index]];
}
for (const entry of targets) {
  process.stdout.write(`${Buffer.from(JSON.stringify(entry), 'utf8').toString('base64')}\n`);
}
NODE
)

if [[ "${#encoded_targets[@]}" -eq 0 ]]; then
  echo "[emergency-rollout] no targets selected from ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

echo "[emergency-rollout] staging functional proof" | tee "${REPORT_DIR}/steps.log"
(
  cd "${ROOT_DIR}"
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
  RUN_WATCH_LIMIT=1 \
  PROOF_SCOPE="${PROOF_SCOPE_VALUE}" \
  bash ./scripts/run-targeted-functional-proof.sh
) > "${REPORT_DIR}/staging-functional-proof.log" 2>&1

for encoded_target in "${encoded_targets[@]}"; do
  readarray -t target_fields < <(node - "${encoded_target}" <<'NODE'
const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
process.stdout.write([
  String(payload.key || ''),
  String(payload.courseId || ''),
  String(payload.courseText || ''),
  String(payload.lessonId || ''),
  String(payload.lessonText || ''),
].join('\n'));
NODE
  )

  target_key="${target_fields[0]}"
  course_id="${target_fields[1]}"
  course_text="${target_fields[2]}"
  lesson_id="${target_fields[3]}"
  lesson_text="${target_fields[4]}"
  manifest_path="${REPORT_DIR}/${target_key}-browser-users.json"
  prepare_log="${REPORT_DIR}/${target_key}-prepare-browser-users.log"
  browser_log="${REPORT_DIR}/${target_key}-browser-ladder.log"

  echo "[emergency-rollout] preparing browser users for ${target_key}" | tee -a "${REPORT_DIR}/steps.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${STAGING_ENV_FILE_PATH}" \
    QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
    QA_COURSE_ID="${course_id}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS=100 \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${manifest_path}" \
    QA_VIDEO_BROWSER_USER_PREFIX="qa.emergency.proof.${target_key}." \
    npm --prefix qa-automation run browser:prepare-video-browser-manifest
  ) > "${prepare_log}" 2>&1

  echo "[emergency-rollout] running browser ladder ${STAGING_BROWSER_STAGES_VALUE} for ${target_key}" | tee -a "${REPORT_DIR}/steps.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${STAGING_ENV_FILE_PATH}" \
    QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
    QA_COURSE_ID="${course_id}" \
    QA_COURSE_TEXT="${course_text}" \
    QA_LESSON_ID="${lesson_id}" \
    QA_LESSON_TEXT="${lesson_text}" \
    QA_VIDEO_BROWSER_STAGES="${STAGING_BROWSER_STAGES_VALUE}" \
    QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS="${CAPTURE_MID_STREAM_VALUE}" \
    COURSE_LOAD_USERS_FILE="${manifest_path}" \
    PLATFORM_LOAD_USERS_FILE="${manifest_path}" \
    bash ./scripts/run-recorded-browser-ladder.sh "${STAGING_BASE_URL_VALUE}"
  ) > "${browser_log}" 2>&1

  latest_browser_summary="$(find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-video-browser-concurrency-summary.json' -print 2>/dev/null | sort | tail -n 1)"
  node - "${target_key}" "${course_id}" "${course_text}" "${lesson_id}" "${lesson_text}" "${manifest_path}" "${prepare_log}" "${browser_log}" "${latest_browser_summary}" >> "${SUMMARY_JSONL}" <<'NODE'
const fs = require('node:fs');
const [
  targetKey,
  courseId,
  courseText,
  lessonId,
  lessonText,
  manifestPath,
  prepareLog,
  browserLog,
  browserSummaryPath,
] = process.argv.slice(2);
const browserSummary = JSON.parse(fs.readFileSync(browserSummaryPath, 'utf8'));
process.stdout.write(`${JSON.stringify({
  key: targetKey,
  courseId,
  courseText,
  lessonId,
  lessonText,
  manifestPath,
  logs: {
    prepareUsers: prepareLog,
    browserLadder: browserLog,
  },
  browserSummaryPath,
  browserSummary,
})}\n`);
NODE
done

if [[ "${DEPLOY_PRODUCTION_VALUE}" == "1" ]]; then
  echo "[emergency-rollout] deploying production with safe rolling deploy" | tee -a "${REPORT_DIR}/steps.log"
  (
    cd "${ROOT_DIR}/infra/lowcost"
    ENV_FILE="${PRODUCTION_ENV_FILE_PATH}" \
    PLAYBACK_DEPLOY_GATE_ENFORCED="1" \
    PLAYBACK_DEPLOY_GATE_SUMMARY="${PLAYBACK_DEPLOY_GATE_SUMMARY:-}" \
    PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL="${PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL:-}" \
    PLAYBACK_DEPLOY_REQUIRED_STAGE="${PLAYBACK_DEPLOY_REQUIRED_STAGE:-2000}" \
    ./safe-production-deploy.sh
  ) > "${REPORT_DIR}/production-deploy.log" 2>&1
fi

if [[ "${RUN_PRODUCTION_SMOKE_VALUE}" == "1" ]]; then
  echo "[emergency-rollout] running production smoke" | tee -a "${REPORT_DIR}/steps.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${PRODUCTION_ENV_FILE_PATH}" \
    QA_BASE_URL="${PRODUCTION_BASE_URL_VALUE}" \
    QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
    bash ./scripts/run-production-targeted-smoke.sh
  ) > "${REPORT_DIR}/production-smoke.log" 2>&1
fi

SUMMARY_PATH="${REPORT_DIR}/emergency-protected-hls-rollout-summary.json"
node - "${SUMMARY_PATH}" "${STAGING_BASE_URL_VALUE}" "${STAGING_ENV_FILE_PATH}" "${PRODUCTION_ENV_FILE_PATH}" "${TARGETS_FILE_VALUE}" "${STAGING_BROWSER_STAGES_VALUE}" "${DEPLOY_PRODUCTION_VALUE}" "${RUN_PRODUCTION_SMOKE_VALUE}" "${SUMMARY_JSONL}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  stagingBaseUrl,
  stagingEnvFile,
  productionEnvFile,
  targetsFile,
  browserStages,
  deployedProduction,
  ranProductionSmoke,
  jsonlPath,
] = process.argv.slice(2);
const targets = fs.existsSync(jsonlPath)
  ? fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const summary = {
  ok: true,
  stagingBaseUrl,
  stagingEnvFile,
  productionEnvFile,
  targetsFile,
  browserStages,
  deployedProduction: deployedProduction === '1',
  ranProductionSmoke: ranProductionSmoke === '1',
  targets,
};
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE
