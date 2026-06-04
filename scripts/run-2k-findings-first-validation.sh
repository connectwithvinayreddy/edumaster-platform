#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_ENV_FILE_PATH="${STAGING_ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
PROD_ENV_FILE_PATH="${PRODUCTION_ENV_FILE:-${ROOT_DIR}/.env.production}"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}"
STAGING_SSH_TARGET_VALUE="${STAGING_SSH_TARGET:-root@46.225.218.53}"
PROD_SSH_TARGET_VALUE="${PROD_SSH_TARGET:-root@178.105.48.179}"
STAGING_BASE_URL_VALUE="${QA_BASE_URL:-${STAGING_BASE_URL:-}}"
PROD_BASE_URL_VALUE="${PRODUCTION_QA_BASE_URL:-https://app.varonenglishapp.in}"
STAGING_VIDEO_BROWSER_STAGES_VALUE="${STAGING_VIDEO_BROWSER_STAGES:-1,3,10,25,50,100,250,500,1000,2000}"
STAGING_MIXED_BROWSER_STAGES_VALUE="${STAGING_MIXED_BROWSER_STAGES:-250,500,1000,1500,2000}"
PRODUCTION_BROWSER_SOAK_STAGES_VALUE="${PRODUCTION_BROWSER_SOAK_STAGES:-100,250}"
BROWSER_FARM_WORKERS_VALUE="${QA_BROWSER_FARM_WORKERS:-local}"
BROWSER_FARM_REMOTE_ROOTS_VALUE="${QA_BROWSER_FARM_REMOTE_ROOTS:-}"
BROWSER_FARM_REMOTE_ROOT_VALUE="${QA_BROWSER_FARM_REMOTE_ROOT:-/opt/edumaster-staging}"
BROWSER_FARM_RUN_CALIBRATION_VALUE="${BROWSER_FARM_RUN_CALIBRATION:-1}"
BROWSER_FARM_CALIBRATION_STAGES_VALUE="${BROWSER_FARM_CALIBRATION_STAGES:-50,100,150}"
BROWSER_FARM_MOBILE_RATIO_VALUE="${QA_BROWSER_FARM_MOBILE_RATIO:-0.4}"
RUN_PRODUCTION_SMOKE_VALUE="${RUN_PRODUCTION_SMOKE:-1}"
RUN_PRODUCTION_BROWSER_SOAK_VALUE="${RUN_PRODUCTION_BROWSER_SOAK:-1}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/2k-findings-first-validation-${RUN_ID}"
STAGE_JSONL="${REPORT_DIR}/stages.jsonl"
NOTES_PATH="${REPORT_DIR}/notes.md"
STAGING_VIDEO_BROWSER_RUN_ID="browser-farm-video-2k-findings-${RUN_ID}"
STAGING_VIDEO_BROWSER_REPORT_DIR="${ROOT_DIR}/reports/${STAGING_VIDEO_BROWSER_RUN_ID}"
STAGING_VIDEO_BROWSER_SUMMARY_PATH="${STAGING_VIDEO_BROWSER_REPORT_DIR}/browser-farm-certification-summary.json"
STAGING_MIXED_BROWSER_RUN_ID="browser-farm-mixed-2k-findings-${RUN_ID}"
STAGING_MIXED_BROWSER_REPORT_DIR="${ROOT_DIR}/reports/${STAGING_MIXED_BROWSER_RUN_ID}"
STAGING_MIXED_BROWSER_SUMMARY_PATH="${STAGING_MIXED_BROWSER_REPORT_DIR}/browser-farm-certification-summary.json"
PRODUCTION_BROWSER_SOAK_RUN_ID="browser-farm-prod-soak-2k-findings-${RUN_ID}"
PRODUCTION_BROWSER_SOAK_REPORT_DIR="${ROOT_DIR}/reports/${PRODUCTION_BROWSER_SOAK_RUN_ID}"
PRODUCTION_BROWSER_SOAK_SUMMARY_PATH="${PRODUCTION_BROWSER_SOAK_REPORT_DIR}/browser-farm-certification-summary.json"

mkdir -p "${REPORT_DIR}"

latest_report_dir() {
  local pattern="$1"
  find "${ROOT_DIR}/reports" -maxdepth 1 -type d -name "${pattern}" -print0 \
    | xargs -0 ls -1dt 2>/dev/null \
    | head -n 1
}

read_env_value() {
  local env_file="$1"
  local key="$2"
  grep -E "^${key}=" "${env_file}" | tail -n 1 | cut -d= -f2- || true
}

max_stage_from_csv() {
  local csv="$1"
  node - "${csv}" <<'NODE'
const values = String(process.argv[2] || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const max = values.length ? Math.max(...values) : 0;
process.stdout.write(`${max}\n`);
NODE
}

if [[ ! -f "${STAGING_ENV_FILE_PATH}" ]]; then
  echo "[2k-findings] missing staging env file: ${STAGING_ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${PROD_ENV_FILE_PATH}" ]]; then
  echo "[2k-findings] missing production env file: ${PROD_ENV_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[2k-findings] missing target manifest: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

STAGING_BASE_URL_VALUE="${STAGING_BASE_URL_VALUE:-$(read_env_value "${STAGING_ENV_FILE_PATH}" APP_URL)}"
if [[ -z "${STAGING_BASE_URL_VALUE}" ]]; then
  echo "[2k-findings] staging base URL is required." >&2
  exit 1
fi

STAGING_COMPOSE_PROJECT="${STAGING_COMPOSE_PROJECT:-$(read_env_value "${STAGING_ENV_FILE_PATH}" COMPOSE_PROJECT_NAME)}"
PROD_COMPOSE_PROJECT="${PROD_COMPOSE_PROJECT:-$(read_env_value "${PROD_ENV_FILE_PATH}" COMPOSE_PROJECT_NAME)}"
STAGING_COMPOSE_PROJECT="${STAGING_COMPOSE_PROJECT:-edumaster-staging-mirror}"
PROD_COMPOSE_PROJECT="${PROD_COMPOSE_PROJECT:-lowcost}"

capture_snapshot() {
  local label="$1"
  local ssh_target="$2"
  local base_url="$3"
  local compose_project="$4"
  bash "${ROOT_DIR}/scripts/capture-load-host-snapshot.sh" "${REPORT_DIR}" "${label}" "${ssh_target}" "${base_url}" "${compose_project}" | tail -n 1
}

write_stage_record() {
  local stage_json="$1"
  printf '%s\n' "${stage_json}" >> "${STAGE_JSONL}"
}

run_stage() {
  local stage_label="$1"
  local stage_kind="$2"
  local stage_scope="$3"
  shift 3
  local log_path="${REPORT_DIR}/$(echo "${stage_label}" | tr ' /' '__').log"
  local evidence_path=""
  local pre_snapshot=""
  local post_snapshot=""
  local ssh_target="${STAGING_SSH_TARGET_VALUE}"
  local base_url="${STAGING_BASE_URL_VALUE}"
  local compose_project="${STAGING_COMPOSE_PROJECT}"

  if [[ "${stage_scope}" == "production" ]]; then
    ssh_target="${PROD_SSH_TARGET_VALUE}"
    base_url="${PROD_BASE_URL_VALUE}"
    compose_project="${PROD_COMPOSE_PROJECT}"
  fi

  pre_snapshot="$(capture_snapshot "${stage_scope}-$(echo "${stage_label}" | tr ' /' '__')-before" "${ssh_target}" "${base_url}" "${compose_project}")"

  set +e
  (
    cd "${ROOT_DIR}"
    "$@"
  ) > "${log_path}" 2>&1
  local exit_code=$?
  set -e

  if [[ "${stage_label}" == *"targeted-functional-proof"* ]]; then
    local latest_proof_dir=""
    if [[ "${stage_scope}" == "staging" ]]; then
      latest_proof_dir="$(latest_report_dir "targeted-functional-proof-2k-findings-staging-*")"
    elif [[ "${stage_scope}" == "production" ]]; then
      latest_proof_dir="$(latest_report_dir "targeted-functional-proof-production-smoke-*")"
    else
      latest_proof_dir="$(latest_report_dir "targeted-functional-proof-*")"
    fi
    if [[ -n "${latest_proof_dir}" ]]; then
      evidence_path="${REPORT_DIR}/$(basename "${log_path}" .log)-evidence.log"
      {
        echo "# evidence from ${latest_proof_dir}"
        find "${latest_proof_dir}" -maxdepth 1 -type f -name '*.log' | sort | while IFS= read -r proof_log; do
          echo
          echo "## ${proof_log}"
          sed -n '1,260p' "${proof_log}"
        done
      } > "${evidence_path}"
    fi
  fi

  post_snapshot="$(capture_snapshot "${stage_scope}-$(echo "${stage_label}" | tr ' /' '__')-after" "${ssh_target}" "${base_url}" "${compose_project}")"

  local classification_json
  classification_json="$(node "${ROOT_DIR}/scripts/classify-2k-stage.mjs" "${stage_label}" "${stage_kind}" "${log_path}" "${pre_snapshot}" "${post_snapshot}" "${evidence_path}")"

  local stage_json
  stage_json="$(node - "${stage_label}" "${stage_kind}" "${stage_scope}" "${log_path}" "${pre_snapshot}" "${post_snapshot}" "${exit_code}" "${classification_json}" "${evidence_path}" <<'NODE'
const [
  stageLabel,
  stageKind,
  stageScope,
  logPath,
  preSnapshotPath,
  postSnapshotPath,
  exitCodeRaw,
  classificationJson,
  evidencePath,
] = process.argv.slice(2);
const stage = {
  label: stageLabel,
  kind: stageKind,
  scope: stageScope,
  ok: Number(exitCodeRaw) === 0,
  exitCode: Number(exitCodeRaw),
  logPath,
  snapshots: {
    before: preSnapshotPath,
    after: postSnapshotPath,
  },
  evidencePath: evidencePath || null,
  classification: JSON.parse(classificationJson),
};
process.stdout.write(JSON.stringify(stage));
NODE
)"

  write_stage_record "${stage_json}"

  if [[ "${exit_code}" -ne 0 ]]; then
    echo "[2k-findings] stage failed: ${stage_label}" | tee -a "${NOTES_PATH}"
    return "${exit_code}"
  fi
}

prepare_browser_manifest() {
  local target_key="$1"
  local course_id="$2"
  local manifest_users="$3"
  local user_prefix="$4"
  local env_file="$5"
  local base_url="$6"
  local manifest_path="${REPORT_DIR}/${target_key}-browser-users.json"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${env_file}" \
    QA_BASE_URL="${base_url}" \
    QA_COURSE_ID="${course_id}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS="${manifest_users}" \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${manifest_path}" \
    QA_VIDEO_BROWSER_USER_PREFIX="${user_prefix}" \
    npm --prefix qa-automation run browser:prepare-video-browser-manifest
  ) > "${REPORT_DIR}/${target_key}-prepare-browser-users.log" 2>&1
  printf '%s\n' "${manifest_path}"
}

STAGING_VIDEO_BROWSER_MAX_STAGE="$(max_stage_from_csv "${STAGING_VIDEO_BROWSER_STAGES_VALUE}")"
STAGING_MIXED_BROWSER_MAX_STAGE="$(max_stage_from_csv "${STAGING_MIXED_BROWSER_STAGES_VALUE}")"
PRODUCTION_BROWSER_SOAK_MAX_STAGE="$(max_stage_from_csv "${PRODUCTION_BROWSER_SOAK_STAGES_VALUE}")"

PRIMARY_TARGET_FIELDS=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  PRIMARY_TARGET_FIELDS+=("${line}")
done < <(node - "${TARGETS_FILE_VALUE}" <<'NODE'
const fs = require('node:fs');
const targets = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const target = targets[1] || targets[0] || {};
process.stdout.write([
  String(target.key || ''),
  String(target.courseId || ''),
  String(target.lessonId || ''),
  String(target.courseText || ''),
  String(target.lessonText || ''),
].join('\n'));
NODE
)

PRIMARY_TARGET_KEY="${PRIMARY_TARGET_FIELDS[0]:-}"
PRIMARY_COURSE_ID="${PRIMARY_TARGET_FIELDS[1]:-}"
PRIMARY_LESSON_ID="${PRIMARY_TARGET_FIELDS[2]:-}"
PRIMARY_COURSE_TEXT="${PRIMARY_TARGET_FIELDS[3]:-}"
PRIMARY_LESSON_TEXT="${PRIMARY_TARGET_FIELDS[4]:-}"

if [[ -z "${PRIMARY_COURSE_ID}" || -z "${PRIMARY_LESSON_ID}" ]]; then
  echo "[2k-findings] unable to resolve a primary target from ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

{
  echo "# 2k Findings-First Validation"
  echo
  echo "- staging host: ${STAGING_SSH_TARGET_VALUE}"
  echo "- prod host: ${PROD_SSH_TARGET_VALUE}"
  echo "- staging base URL: ${STAGING_BASE_URL_VALUE}"
  echo "- prod base URL: ${PROD_BASE_URL_VALUE}"
  echo "- staging compose project: ${STAGING_COMPOSE_PROJECT}"
  echo "- prod compose project: ${PROD_COMPOSE_PROJECT}"
  echo "- target manifest: ${TARGETS_FILE_VALUE}"
  echo "- browser farm workers: ${BROWSER_FARM_WORKERS_VALUE}"
  echo "- browser farm remote roots: ${BROWSER_FARM_REMOTE_ROOTS_VALUE:-${BROWSER_FARM_REMOTE_ROOT_VALUE}}"
  echo "- staging video browser stages: ${STAGING_VIDEO_BROWSER_STAGES_VALUE}"
  echo "- staging mixed browser stages: ${STAGING_MIXED_BROWSER_STAGES_VALUE}"
  echo "- production browser soak stages: ${PRODUCTION_BROWSER_SOAK_STAGES_VALUE}"
  echo
} > "${NOTES_PATH}"

STAGING_BASELINE_SNAPSHOT="$(capture_snapshot "staging-baseline" "${STAGING_SSH_TARGET_VALUE}" "${STAGING_BASE_URL_VALUE}" "${STAGING_COMPOSE_PROJECT}")"
PROD_BASELINE_SNAPSHOT="$(capture_snapshot "prod-baseline" "${PROD_SSH_TARGET_VALUE}" "${PROD_BASE_URL_VALUE}" "${PROD_COMPOSE_PROJECT}")"

node - "${STAGING_BASELINE_SNAPSHOT}" "${PROD_BASELINE_SNAPSHOT}" <<'NODE' >> "${NOTES_PATH}"
const fs = require('node:fs');
const [stagingPath, prodPath] = process.argv.slice(2);
for (const [label, filePath] of [['staging', stagingPath], ['prod', prodPath]]) {
  const summary = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const restarting = summary.restartingContainers || [];
  const unhealthy = summary.unhealthyContainers || [];
  const badEndpoints = (summary.endpointStatuses || []).filter((entry) => entry.ok === false);
  process.stdout.write(`## ${label} baseline\n`);
  process.stdout.write(`- hostname: ${summary.hostname || 'unknown'}\n`);
  process.stdout.write(`- restarting containers: ${restarting.length ? restarting.join(', ') : 'none'}\n`);
  process.stdout.write(`- unhealthy containers: ${unhealthy.length ? unhealthy.join(', ') : 'none'}\n`);
  process.stdout.write(`- bad endpoints: ${badEndpoints.length ? badEndpoints.map((entry) => `${entry.endpoint}=${entry.status}`).join(', ') : 'none'}\n\n`);
}
NODE

run_stage "staging-targeted-functional-proof" "correctness" "staging" \
  env \
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
  RUN_WATCH_LIMIT=1 \
  PROOF_SCOPE="2k-findings-staging" \
  bash "${ROOT_DIR}/scripts/run-targeted-functional-proof.sh"

PRIMARY_VIDEO_MANIFEST_PATH="$(prepare_browser_manifest \
  "${PRIMARY_TARGET_KEY:-primary}-video-2k" \
  "${PRIMARY_COURSE_ID}" \
  "${STAGING_VIDEO_BROWSER_MAX_STAGE}" \
  "qa.2k.video.${PRIMARY_TARGET_KEY:-primary}." \
  "${STAGING_ENV_FILE_PATH}" \
  "${STAGING_BASE_URL_VALUE}")"

run_stage "staging-distributed-video-browser-ladder" "distributed_video_browser_ladder" "staging" \
  env \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  QA_COURSE_ID="${PRIMARY_COURSE_ID}" \
  QA_COURSE_TEXT="${PRIMARY_COURSE_TEXT}" \
  QA_LESSON_ID="${PRIMARY_LESSON_ID}" \
  QA_LESSON_TEXT="${PRIMARY_LESSON_TEXT}" \
  QA_BROWSER_FARM_MANIFEST="${PRIMARY_VIDEO_MANIFEST_PATH}" \
  QA_BROWSER_FARM_STAGES="${STAGING_VIDEO_BROWSER_STAGES_VALUE}" \
  QA_BROWSER_FARM_WORKERS="${BROWSER_FARM_WORKERS_VALUE}" \
  QA_BROWSER_FARM_REMOTE_ROOTS="${BROWSER_FARM_REMOTE_ROOTS_VALUE}" \
  QA_BROWSER_FARM_REMOTE_ROOT="${BROWSER_FARM_REMOTE_ROOT_VALUE}" \
  QA_BROWSER_FARM_RUN_ID="${STAGING_VIDEO_BROWSER_RUN_ID}" \
  QA_BROWSER_FARM_MOBILE_RATIO="${BROWSER_FARM_MOBILE_RATIO_VALUE}" \
  BROWSER_FARM_RUN_CALIBRATION="${BROWSER_FARM_RUN_CALIBRATION_VALUE}" \
  BROWSER_FARM_CALIBRATION_STAGES="${BROWSER_FARM_CALIBRATION_STAGES_VALUE}" \
  BROWSER_FARM_MODE="video" \
  bash "${ROOT_DIR}/scripts/run-distributed-browser-farm-ladder.sh" "${STAGING_BASE_URL_VALUE}"

STAGING_MIXED_MANIFEST_PATH="$(prepare_browser_manifest \
  "mixed-2k" \
  "${PRIMARY_COURSE_ID}" \
  "${STAGING_MIXED_BROWSER_MAX_STAGE}" \
  "qa.2k.mixed.primary." \
  "${STAGING_ENV_FILE_PATH}" \
  "${STAGING_BASE_URL_VALUE}")"

run_stage "staging-distributed-mixed-browser-ladder" "distributed_mixed_browser_ladder" "staging" \
  env \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  QA_COURSE_ID="${PRIMARY_COURSE_ID}" \
  QA_COURSE_TEXT="${PRIMARY_COURSE_TEXT}" \
  QA_LESSON_ID="${PRIMARY_LESSON_ID}" \
  QA_LESSON_TEXT="${PRIMARY_LESSON_TEXT}" \
  QA_BROWSER_FARM_MANIFEST="${STAGING_MIXED_MANIFEST_PATH}" \
  QA_BROWSER_FARM_STAGES="${STAGING_MIXED_BROWSER_STAGES_VALUE}" \
  QA_BROWSER_FARM_WORKERS="${BROWSER_FARM_WORKERS_VALUE}" \
  QA_BROWSER_FARM_REMOTE_ROOTS="${BROWSER_FARM_REMOTE_ROOTS_VALUE}" \
  QA_BROWSER_FARM_REMOTE_ROOT="${BROWSER_FARM_REMOTE_ROOT_VALUE}" \
  QA_BROWSER_FARM_RUN_ID="${STAGING_MIXED_BROWSER_RUN_ID}" \
  QA_BROWSER_FARM_MOBILE_RATIO="${BROWSER_FARM_MOBILE_RATIO_VALUE}" \
  BROWSER_FARM_RUN_CALIBRATION="0" \
  BROWSER_FARM_MODE="mixed" \
  bash "${ROOT_DIR}/scripts/run-distributed-browser-farm-ladder.sh" "${STAGING_BASE_URL_VALUE}"

if [[ "${RUN_PRODUCTION_SMOKE_VALUE}" == "1" ]]; then
  run_stage "production-targeted-video-smoke" "production_smoke" "production" \
    env \
    ENV_FILE="${PROD_ENV_FILE_PATH}" \
    QA_BASE_URL="${PROD_BASE_URL_VALUE}" \
    QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
    bash "${ROOT_DIR}/scripts/run-production-targeted-smoke.sh"

  run_stage "production-auth-persistence-smoke" "production_smoke" "production" \
    env \
    ENV_FILE="${PROD_ENV_FILE_PATH}" \
    QA_BASE_URL="${PROD_BASE_URL_VALUE}" \
    QA_COURSE_ID="${PRIMARY_COURSE_ID}" \
    npm --prefix qa-automation run browser:auth-persistence

  run_stage "production-courses-smoke" "production_smoke" "production" \
    env \
    ENV_FILE="${PROD_ENV_FILE_PATH}" \
    QA_BASE_URL="${PROD_BASE_URL_VALUE}" \
    npm --prefix qa-automation run browser:courses

  run_stage "production-tests-smoke" "production_smoke" "production" \
    env \
    ENV_FILE="${PROD_ENV_FILE_PATH}" \
    QA_BASE_URL="${PROD_BASE_URL_VALUE}" \
    npm --prefix qa-automation run browser:tests

  if [[ "${RUN_PRODUCTION_BROWSER_SOAK_VALUE}" == "1" ]]; then
    PROD_BROWSER_SOAK_MANIFEST_PATH="$(prepare_browser_manifest \
      "production-browser-soak" \
      "${PRIMARY_COURSE_ID}" \
      "${PRODUCTION_BROWSER_SOAK_MAX_STAGE}" \
      "qa.2k.prod.soak." \
      "${PROD_ENV_FILE_PATH}" \
      "${PROD_BASE_URL_VALUE}")"

    run_stage "production-browser-soak" "production_browser_soak" "production" \
      env \
      QA_BASE_URL="${PROD_BASE_URL_VALUE}" \
      ENV_FILE="${PROD_ENV_FILE_PATH}" \
      QA_COURSE_ID="${PRIMARY_COURSE_ID}" \
      QA_COURSE_TEXT="${PRIMARY_COURSE_TEXT}" \
      QA_LESSON_ID="${PRIMARY_LESSON_ID}" \
      QA_LESSON_TEXT="${PRIMARY_LESSON_TEXT}" \
      QA_BROWSER_FARM_MANIFEST="${PROD_BROWSER_SOAK_MANIFEST_PATH}" \
      QA_BROWSER_FARM_STAGES="${PRODUCTION_BROWSER_SOAK_STAGES_VALUE}" \
      QA_BROWSER_FARM_WORKERS="${BROWSER_FARM_WORKERS_VALUE}" \
      QA_BROWSER_FARM_REMOTE_ROOTS="${BROWSER_FARM_REMOTE_ROOTS_VALUE}" \
      QA_BROWSER_FARM_REMOTE_ROOT="${BROWSER_FARM_REMOTE_ROOT_VALUE}" \
      QA_BROWSER_FARM_RUN_ID="${PRODUCTION_BROWSER_SOAK_RUN_ID}" \
      QA_BROWSER_FARM_MOBILE_RATIO="${BROWSER_FARM_MOBILE_RATIO_VALUE}" \
      BROWSER_FARM_RUN_CALIBRATION="0" \
      BROWSER_FARM_MODE="mixed" \
      bash "${ROOT_DIR}/scripts/run-distributed-browser-farm-ladder.sh" "${PROD_BASE_URL_VALUE}"
  fi
fi

SUMMARY_PATH="${REPORT_DIR}/2k-findings-first-summary.json"
PLAYBACK_GATE_SUMMARY_PATH="${REPORT_DIR}/protected-hls-playback-deploy-gate-summary.json"
node - "${SUMMARY_PATH}" "${PLAYBACK_GATE_SUMMARY_PATH}" "${REPORT_DIR}" "${STAGING_BASE_URL_VALUE}" "${PROD_BASE_URL_VALUE}" "${TARGETS_FILE_VALUE}" "${STAGING_BASELINE_SNAPSHOT}" "${PROD_BASELINE_SNAPSHOT}" "${STAGE_JSONL}" "${STAGING_VIDEO_BROWSER_SUMMARY_PATH}" "${STAGING_MIXED_BROWSER_SUMMARY_PATH}" "${PRODUCTION_BROWSER_SOAK_SUMMARY_PATH}" "${STAGING_VIDEO_BROWSER_STAGES_VALUE}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  playbackGateOutputPath,
  reportDir,
  stagingBaseUrl,
  prodBaseUrl,
  targetsFile,
  stagingBaselineSnapshot,
  prodBaselineSnapshot,
  stageJsonlPath,
  videoBrowserSummaryPath,
  mixedBrowserSummaryPath,
  productionBrowserSoakSummaryPath,
  requiredVideoStagesCsv,
] = process.argv.slice(2);
const stages = fs.existsSync(stageJsonlPath)
  ? fs.readFileSync(stageJsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const firstFailure = stages.find((stage) => !stage.ok) || null;
const readJsonIfExists = (filePath) => (
  filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null
);
const videoBrowserSummary = readJsonIfExists(videoBrowserSummaryPath);
const mixedBrowserSummary = readJsonIfExists(mixedBrowserSummaryPath);
const productionBrowserSoakSummary = readJsonIfExists(productionBrowserSoakSummaryPath);
const summary = {
  ok: firstFailure == null,
  reportDir,
  stagingBaseUrl,
  prodBaseUrl,
  targetsFile,
  baselineSnapshots: {
    staging: stagingBaselineSnapshot,
    production: prodBaselineSnapshot,
  },
  stageCount: stages.length,
  firstFailure,
  stages,
  browserFarm: {
    video: {
      summaryPath: videoBrowserSummaryPath,
      summary: videoBrowserSummary,
    },
    mixed: {
      summaryPath: mixedBrowserSummaryPath,
      summary: mixedBrowserSummary,
    },
    productionSoak: {
      summaryPath: productionBrowserSoakSummaryPath,
      summary: productionBrowserSoakSummary,
    },
  },
};
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

const requiredVideoStages = String(requiredVideoStagesCsv || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const requiredStage = requiredVideoStages.length ? Math.max(...requiredVideoStages) : 2000;
const videoBlockingFailures = Array.isArray(videoBrowserSummary?.blockingFailures) ? videoBrowserSummary.blockingFailures : [];
const playbackGateSummary = {
  gate: 'protected_hls_playback_production_deploy',
  reportDir,
  generatedAt: new Date().toISOString(),
  sourceSummaryPath: outputPath,
  requiredVideoStages,
  requiredStage,
  exactRealBrowserCount: Number(videoBrowserSummary?.exactRealBrowserCount || 0),
  exactSyntheticDiagnosticCount: Number(videoBrowserSummary?.exactSyntheticDiagnosticCount || 0),
  allUsersRealBrowsers: videoBrowserSummary?.allUsersRealBrowsers !== false,
  requiredStagePassed: Boolean(videoBrowserSummary?.requiredStagePassed),
  videoBrowserSummaryPath,
  mixedBrowserSummaryPath,
  productionBrowserSoakSummaryPath,
  firstFailure,
  blockingFailures: [
    ...(firstFailure ? [`2k_findings_first_failure:${firstFailure.label}`] : []),
    ...videoBlockingFailures,
  ],
  eligibleForManualProductionApproval: Boolean(
    !firstFailure
    && videoBrowserSummary
    && videoBrowserSummary.eligibleForManualProductionApproval
  ),
  finalVerdict: !firstFailure && videoBrowserSummary?.eligibleForManualProductionApproval
    ? 'deploy_blocked_pending_manual_approval'
    : 'deploy_blocked',
  deployApproved: false,
  manualApprovalRequired: true,
};
fs.writeFileSync(playbackGateOutputPath, `${JSON.stringify(playbackGateSummary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "[2k-findings] summary: ${SUMMARY_PATH}"
echo "[2k-findings] playback deploy gate summary: ${PLAYBACK_GATE_SUMMARY_PATH}"
