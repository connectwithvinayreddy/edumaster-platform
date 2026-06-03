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
STAGING_BROWSER_STAGES_VALUE="${STAGING_BROWSER_STAGES:-50,100,250}"
STAGING_SYNTHETIC_STAGES_VALUE="${STAGING_SYNTHETIC_STAGES:-250,500,750,1000}"
STAGING_MIXED_STAGES_VALUE="${STAGING_MIXED_STAGES:-500,1000,1500,2000}"
RUN_PRODUCTION_SMOKE_VALUE="${RUN_PRODUCTION_SMOKE:-1}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/2k-findings-first-validation-${RUN_ID}"
STAGE_JSONL="${REPORT_DIR}/stages.jsonl"
NOTES_PATH="${REPORT_DIR}/notes.md"

mkdir -p "${REPORT_DIR}"

read_env_value() {
  local env_file="$1"
  local key="$2"
  grep -E "^${key}=" "${env_file}" | tail -n 1 | cut -d= -f2- || true
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
      latest_proof_dir="$(find "${ROOT_DIR}/reports" -maxdepth 1 -type d -name "targeted-functional-proof-2k-findings-staging-*" | sort | tail -n 1)"
    elif [[ "${stage_scope}" == "production" ]]; then
      latest_proof_dir="$(find "${ROOT_DIR}/reports" -maxdepth 1 -type d -name "targeted-functional-proof-production-smoke-*" | sort | tail -n 1)"
    else
      latest_proof_dir="$(find "${ROOT_DIR}/reports" -maxdepth 1 -type d -name "targeted-functional-proof-*" | sort | tail -n 1)"
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
  local manifest_path="${REPORT_DIR}/${target_key}-browser-users.json"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${STAGING_ENV_FILE_PATH}" \
    QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
    QA_COURSE_ID="${course_id}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS=250 \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${manifest_path}" \
    QA_VIDEO_BROWSER_USER_PREFIX="qa.2k.findings.${target_key}." \
    npm --prefix qa-automation run browser:prepare-video-browser-manifest
  ) > "${REPORT_DIR}/${target_key}-prepare-browser-users.log" 2>&1
  printf '%s\n' "${manifest_path}"
}

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

TARGET_ROWS=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  TARGET_ROWS+=("${line}")
done < <(node - "${TARGETS_FILE_VALUE}" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const entry of payload.slice(0, 2)) {
  process.stdout.write([
    entry.key || '',
    entry.courseId || '',
    entry.courseText || '',
    entry.lessonId || '',
    entry.lessonText || '',
  ].join('\t') + '\n');
}
NODE
)

for row in "${TARGET_ROWS[@]}"; do
  IFS=$'\t' read -r target_key course_id course_text lesson_id lesson_text <<< "${row}"
  manifest_path="$(prepare_browser_manifest "${target_key}" "${course_id}")"
  run_stage "staging-recorded-browser-${target_key}" "browser_ladder" "staging" \
    env \
    ENV_FILE="${STAGING_ENV_FILE_PATH}" \
    QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
    QA_COURSE_ID="${course_id}" \
    QA_COURSE_TEXT="${course_text}" \
    QA_LESSON_ID="${lesson_id}" \
    QA_LESSON_TEXT="${lesson_text}" \
    QA_VIDEO_BROWSER_STAGES="${STAGING_BROWSER_STAGES_VALUE}" \
    COURSE_LOAD_USERS_FILE="${manifest_path}" \
    PLATFORM_LOAD_USERS_FILE="${manifest_path}" \
    bash "${ROOT_DIR}/scripts/run-recorded-browser-ladder.sh" "${STAGING_BASE_URL_VALUE}"
done

run_stage "staging-recorded-synthetic" "synthetic_video_ladder" "staging" \
  env \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  COURSE_LOAD_COURSE_ID="${PRIMARY_COURSE_ID}" \
  COURSE_LOAD_LESSON_ID="${PRIMARY_LESSON_ID}" \
  COURSE_VIDEO_LADDER_STAGES="${STAGING_SYNTHETIC_STAGES_VALUE}" \
  bash "${ROOT_DIR}/scripts/run-course-video-ladder.sh" "${STAGING_BASE_URL_VALUE}"

run_stage "staging-mixed-platform" "mixed_platform_ladder" "staging" \
  env \
  QA_BASE_URL="${STAGING_BASE_URL_VALUE}" \
  ENV_FILE="${STAGING_ENV_FILE_PATH}" \
  PLATFORM_LADDER_STAGES="${STAGING_MIXED_STAGES_VALUE}" \
  PLATFORM_LOAD_TRAFFIC_MODEL="5k-mixed" \
  PLATFORM_LOAD_BROWSE_READ_PERCENT=70 \
  PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT=15 \
  PLATFORM_LOAD_AUTH_SESSION_PERCENT=10 \
  PLATFORM_LOAD_LIGHT_WRITE_PERCENT=5 \
  PLATFORM_LOAD_COURSE_ID="${PRIMARY_COURSE_ID}" \
  PLATFORM_LOAD_LESSON_ID="${PRIMARY_LESSON_ID}" \
  bash "${ROOT_DIR}/scripts/run-platform-scale-ladder.sh" "${STAGING_BASE_URL_VALUE}"

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
fi

SUMMARY_PATH="${REPORT_DIR}/2k-findings-first-summary.json"
node - "${SUMMARY_PATH}" "${REPORT_DIR}" "${STAGING_BASE_URL_VALUE}" "${PROD_BASE_URL_VALUE}" "${TARGETS_FILE_VALUE}" "${STAGING_BASELINE_SNAPSHOT}" "${PROD_BASELINE_SNAPSHOT}" "${STAGE_JSONL}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  reportDir,
  stagingBaseUrl,
  prodBaseUrl,
  targetsFile,
  stagingBaselineSnapshot,
  prodBaselineSnapshot,
  stageJsonlPath,
] = process.argv.slice(2);
const stages = fs.existsSync(stageJsonlPath)
  ? fs.readFileSync(stageJsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const firstFailure = stages.find((stage) => !stage.ok) || null;
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
};
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "[2k-findings] summary: ${SUMMARY_PATH}"
