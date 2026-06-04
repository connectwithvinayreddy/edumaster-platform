#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${BROWSER_FARM_MODE:-video}"
BASE_URL="${QA_BASE_URL:-${1:-}}"
MANIFEST_FILE="${QA_BROWSER_FARM_MANIFEST:-${PLATFORM_LOAD_USERS_FILE:-${COURSE_LOAD_USERS_FILE:-}}}"
WORKERS_CSV="${QA_BROWSER_FARM_WORKERS:-local}"
REMOTE_ROOTS_CSV="${QA_BROWSER_FARM_REMOTE_ROOTS:-}"
DEFAULT_REMOTE_ROOT="${QA_BROWSER_FARM_REMOTE_ROOT:-/opt/edumaster-staging}"
STAGES_CSV="${QA_BROWSER_FARM_STAGES:-}"
ENV_FILE_VALUE="${ENV_FILE:-.env.staging.private-mirror}"
COURSE_ID_VALUE="${QA_COURSE_ID:-${PLATFORM_LOAD_COURSE_ID:-}}"
COURSE_TEXT_VALUE="${QA_COURSE_TEXT:-${PLATFORM_LOAD_COURSE_TEXT:-SSC}}"
LESSON_ID_VALUE="${QA_LESSON_ID:-${PLATFORM_LOAD_LESSON_ID:-}}"
LESSON_TEXT_VALUE="${QA_LESSON_TEXT:-${PLATFORM_LOAD_LESSON_TEXT:-INTRODUCTION}}"
RUN_ID="${QA_BROWSER_FARM_RUN_ID:-browser-farm-${MODE}-$(date -u +"%Y-%m-%dT%H-%M-%SZ")}"
REPORT_DIR="${ROOT_DIR}/reports/${RUN_ID}"
SHARD_DIR="${REPORT_DIR}/shards"
ARTIFACT_DIR="${REPORT_DIR}/worker-artifacts"
RUN_CALIBRATION="${BROWSER_FARM_RUN_CALIBRATION:-1}"
CALIBRATION_STAGES="${BROWSER_FARM_CALIBRATION_STAGES:-50,100,150}"
MOBILE_RATIO_VALUE="${QA_VIDEO_BROWSER_MOBILE_RATIO:-${QA_MIXED_BROWSER_MOBILE_RATIO:-0.4}}"

mkdir -p "${REPORT_DIR}" "${SHARD_DIR}" "${ARTIFACT_DIR}"

if [[ -z "${BASE_URL}" ]]; then
  echo "[browser-farm] QA_BASE_URL is required." >&2
  exit 1
fi

if [[ -z "${MANIFEST_FILE}" || ! -f "${MANIFEST_FILE}" ]]; then
  echo "[browser-farm] prepared user manifest is required: ${MANIFEST_FILE}" >&2
  exit 1
fi

if [[ -z "${COURSE_ID_VALUE}" || -z "${LESSON_ID_VALUE}" ]]; then
  echo "[browser-farm] QA_COURSE_ID and QA_LESSON_ID are required." >&2
  exit 1
fi

if [[ -z "${STAGES_CSV}" ]]; then
  if [[ "${MODE}" == "video" ]]; then
    STAGES_CSV="1,3,10,25,50,100,250,500,1000,2000"
  else
    STAGES_CSV="250,500,1000,1500,2000"
  fi
fi

if [[ "${MODE}" == "video" ]]; then
  RUNNER_SCRIPT="browser:course-video-browser-concurrency"
  SUMMARY_FILE="course-video-browser-concurrency-summary.json"
  STAGE_ENV_KEY="QA_VIDEO_BROWSER_STAGES"
  CONCURRENCY_ENV_KEY="QA_VIDEO_BROWSER_STAGE_CONCURRENCY"
else
  RUNNER_SCRIPT="browser:mixed-feature-browser-concurrency"
  SUMMARY_FILE="browser-mixed-feature-concurrency-summary.json"
  STAGE_ENV_KEY="QA_MIXED_BROWSER_STAGES"
  CONCURRENCY_ENV_KEY="QA_MIXED_BROWSER_STAGE_CONCURRENCY"
fi

WORKERS=()
IFS=',' read -r -a WORKERS <<< "${WORKERS_CSV}"
for i in "${!WORKERS[@]}"; do
  WORKERS[$i]="$(echo "${WORKERS[$i]}" | xargs)"
done
if [[ "${#WORKERS[@]}" -eq 0 ]]; then
  echo "[browser-farm] no workers configured." >&2
  exit 1
fi

if [[ -n "${REMOTE_ROOTS_CSV}" ]]; then
  REMOTE_ROOTS=()
  IFS=',' read -r -a REMOTE_ROOTS <<< "${REMOTE_ROOTS_CSV}"
  for i in "${!REMOTE_ROOTS[@]}"; do
    REMOTE_ROOTS[$i]="$(echo "${REMOTE_ROOTS[$i]}" | xargs)"
  done
else
  REMOTE_ROOTS=()
  for worker in "${WORKERS[@]}"; do
    if [[ "${worker}" == "local" ]]; then
      REMOTE_ROOTS+=("${ROOT_DIR}")
    else
      REMOTE_ROOTS+=("${DEFAULT_REMOTE_ROOT}")
    fi
  done
fi

if [[ "${#REMOTE_ROOTS[@]}" -ne "${#WORKERS[@]}" ]]; then
  echo "[browser-farm] QA_BROWSER_FARM_REMOTE_ROOTS must match worker count." >&2
  exit 1
fi

run_node_json() {
  node --input-type=module - "$@"
}

run_worker_job() {
  local worker="$1"
  local remote_root="$2"
  local shard_manifest="$3"
  local stage_value="$4"
  local worker_index="$5"
  local shard_run_id="$6"
  local shard_label="$7"
  local shard_summary_local="$8"
  local shard_archive_local="$9"

  local extra_env=(
    "ENV_FILE=${ENV_FILE_VALUE}"
    "QA_BASE_URL=${BASE_URL}"
    "QA_COURSE_ID=${COURSE_ID_VALUE}"
    "QA_COURSE_TEXT=${COURSE_TEXT_VALUE}"
    "QA_LESSON_ID=${LESSON_ID_VALUE}"
    "QA_LESSON_TEXT=${LESSON_TEXT_VALUE}"
    "QA_BROWSER_WORKER_LABEL=worker-${worker_index}"
    "QA_BROWSER_SHARD_ID=${shard_label}"
    "QA_RUN_ID_OVERRIDE=${shard_run_id}"
    "QA_VIDEO_BROWSER_SCREENSHOT_ALL=1"
    "QA_MIXED_BROWSER_SCREENSHOT_ALL=1"
    "QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS=true"
    "QA_VIDEO_BROWSER_MOBILE_RATIO=${MOBILE_RATIO_VALUE}"
    "QA_MIXED_BROWSER_MOBILE_RATIO=${MOBILE_RATIO_VALUE}"
    "${STAGE_ENV_KEY}=${stage_value}"
    "${CONCURRENCY_ENV_KEY}=${stage_value}"
  )

  if [[ "${worker}" == "local" ]]; then
    (
      cd "${remote_root}"
      env "${extra_env[@]}" \
        PLATFORM_LOAD_USERS_FILE="${shard_manifest}" \
        COURSE_LOAD_USERS_FILE="${shard_manifest}" \
        npm --prefix qa-automation run "${RUNNER_SCRIPT}"
    )
    cp "${remote_root}/qa-automation/artifacts/${shard_run_id}/analysis/${SUMMARY_FILE}" "${shard_summary_local}"
    tar -czf "${shard_archive_local}" -C "${remote_root}/qa-automation/artifacts" "${shard_run_id}"
    return
  fi

  local remote_manifest="/tmp/${shard_run_id}.json"
  scp -q "${shard_manifest}" "${worker}:${remote_manifest}"
  ssh "${worker}" "cd '${remote_root}' && env ${extra_env[*]@Q} PLATFORM_LOAD_USERS_FILE='${remote_manifest}' COURSE_LOAD_USERS_FILE='${remote_manifest}' npm --prefix qa-automation run '${RUNNER_SCRIPT}'"
  scp -q "${worker}:${remote_root}/qa-automation/artifacts/${shard_run_id}/analysis/${SUMMARY_FILE}" "${shard_summary_local}"
  ssh "${worker}" "tar -czf '/tmp/${shard_run_id}.tgz' -C '${remote_root}/qa-automation/artifacts' '${shard_run_id}'"
  scp -q "${worker}:/tmp/${shard_run_id}.tgz" "${shard_archive_local}"
}

extract_capacity() {
  local summary_path="$1"
  node --input-type=module - "${summary_path}" <<'NODE'
import fs from 'node:fs';
const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const passed = Array.isArray(summary.stages) ? summary.stages.filter((stage) => stage.ok) : [];
const capacity = passed.length ? Math.max(...passed.map((stage) => Number(stage.viewers || 0))) : 0;
process.stdout.write(`${capacity}\n`);
NODE
}

if [[ "${MODE}" == "video" && "${RUN_CALIBRATION}" == "1" ]]; then
  echo "[browser-farm] calibration on ${WORKERS[0]} with stages ${CALIBRATION_STAGES}" | tee -a "${REPORT_DIR}/notes.log"
  CALIBRATION_MANIFEST="${SHARD_DIR}/calibration.json"
  node --input-type=module - "${MANIFEST_FILE}" "${CALIBRATION_MANIFEST}" <<'NODE'
import fs from 'node:fs';
const [inputPath, outputPath] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
fs.writeFileSync(outputPath, `${JSON.stringify(users.slice(0, 150), null, 2)}\n`);
NODE
  CALIBRATION_RUN_ID="${RUN_ID}-calibration"
  CALIBRATION_SUMMARY="${REPORT_DIR}/calibration-summary.json"
  CALIBRATION_ARCHIVE="${ARTIFACT_DIR}/${CALIBRATION_RUN_ID}.tgz"
  OLD_STAGE_ENV="${STAGE_ENV_KEY}"
  OLD_CONCURRENCY_ENV="${CONCURRENCY_ENV_KEY}"
  STAGE_ENV_KEY_VALUE="${STAGE_ENV_KEY}"
  CONCURRENCY_ENV_KEY_VALUE="${CONCURRENCY_ENV_KEY}"
  # shellcheck disable=SC2034
  run_worker_job "${WORKERS[0]}" "${REMOTE_ROOTS[0]}" "${CALIBRATION_MANIFEST}" "${CALIBRATION_STAGES}" 1 "${CALIBRATION_RUN_ID}" "calibration" "${CALIBRATION_SUMMARY}" "${CALIBRATION_ARCHIVE}"
  WORKER_CAPACITY="$(extract_capacity "${CALIBRATION_SUMMARY}")"
  if [[ "${WORKER_CAPACITY}" -le 0 ]]; then
    echo "[browser-farm] calibration failed to produce any passing browser capacity." >&2
    exit 1
  fi
else
  WORKER_CAPACITY="${BROWSER_FARM_WORKER_CAPACITY_OVERRIDE:-250}"
fi

echo "[browser-farm] worker capacity=${WORKER_CAPACITY} workers=${#WORKERS[@]}" | tee -a "${REPORT_DIR}/notes.log"

STAGES=()
IFS=',' read -r -a STAGES <<< "${STAGES_CSV}"
for i in "${!STAGES[@]}"; do
  STAGES[$i]="$(echo "${STAGES[$i]}" | xargs)"
done

MERGED_PATHS=()

for stage_value in "${STAGES[@]}"; do
  [[ -z "${stage_value}" ]] && continue
  if ! [[ "${stage_value}" =~ ^[0-9]+$ ]]; then
    echo "[browser-farm] skipping invalid stage ${stage_value}" >&2
    continue
  fi
  required_workers=$(( (stage_value + WORKER_CAPACITY - 1) / WORKER_CAPACITY ))
  if [[ "${required_workers}" -gt "${#WORKERS[@]}" ]]; then
    echo "BROWSER_FARM_CAPACITY_EXHAUSTED stage=${stage_value} worker_capacity=${WORKER_CAPACITY} available_workers=${#WORKERS[@]} required_workers=${required_workers}" | tee -a "${REPORT_DIR}/notes.log" >&2
    exit 1
  fi

  counts=()
  remaining="${stage_value}"
  for (( worker_idx=0; worker_idx<required_workers; worker_idx+=1 )); do
    slots_left=$(( required_workers - worker_idx ))
    shard_count=$(( (remaining + slots_left - 1) / slots_left ))
    if [[ "${shard_count}" -gt "${WORKER_CAPACITY}" ]]; then
      shard_count="${WORKER_CAPACITY}"
    fi
    counts+=("${shard_count}")
    remaining=$(( remaining - shard_count ))
  done

  stage_shard_dir="${SHARD_DIR}/stage-${stage_value}"
  mkdir -p "${stage_shard_dir}"
  split_output_json="${stage_shard_dir}/split.json"
  QA_BROWSER_FARM_INPUT_MANIFEST="${MANIFEST_FILE}" \
  QA_BROWSER_FARM_SPLIT_COUNTS="$(IFS=,; echo "${counts[*]}")" \
  QA_BROWSER_FARM_OUTPUT_DIR="${stage_shard_dir}" \
  QA_BROWSER_FARM_SHARD_PREFIX="stage-${stage_value}" \
  node --import tsx "${ROOT_DIR}/qa-automation/src/browser-farm-split-manifest.ts" > "${split_output_json}"

  summary_paths=()
  pids=()
  for (( worker_idx=0; worker_idx<required_workers; worker_idx+=1 )); do
    shard_number="$(printf '%02d' $((worker_idx + 1)))"
    shard_manifest="${stage_shard_dir}/stage-${stage_value}-${shard_number}.json"
    shard_run_id="${RUN_ID}-stage-${stage_value}-worker-${shard_number}"
    shard_label="stage-${stage_value}-${shard_number}"
    shard_summary_local="${stage_shard_dir}/${shard_label}-summary.json"
    shard_archive_local="${ARTIFACT_DIR}/${shard_run_id}.tgz"
    summary_paths+=("${shard_summary_local}")
    run_worker_job "${WORKERS[worker_idx]}" "${REMOTE_ROOTS[worker_idx]}" "${shard_manifest}" "${counts[worker_idx]}" "$((worker_idx + 1))" "${shard_run_id}" "${shard_label}" "${shard_summary_local}" "${shard_archive_local}" &
    pids+=("$!")
  done

  stage_failed=0
  for pid in "${pids[@]}"; do
    if ! wait "${pid}"; then
      stage_failed=1
    fi
  done
  if [[ "${stage_failed}" -ne 0 ]]; then
    echo "[browser-farm] stage ${stage_value} failed on one or more workers" >&2
    exit 1
  fi

  merged_path="${REPORT_DIR}/stage-${stage_value}-merged.json"
  QA_BROWSER_FARM_MODE="${MODE}" \
  QA_BROWSER_FARM_STAGE="${stage_value}" \
  QA_BROWSER_FARM_SUMMARY_PATHS="$(IFS=,; echo "${summary_paths[*]}")" \
  QA_BROWSER_FARM_MERGED_OUTPUT="${merged_path}" \
  node --import tsx "${ROOT_DIR}/qa-automation/src/browser-farm-merge-results.ts" | tee "${REPORT_DIR}/stage-${stage_value}-merged.log"
  MERGED_PATHS+=("${merged_path}")

  if ! node --input-type=module - "${merged_path}" <<'NODE'
import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(payload.ok ? 0 : 1);
NODE
  then
    echo "[browser-farm] merged stage ${stage_value} failed" >&2
    exit 1
  fi
done

CERTIFICATION_SUMMARY_PATH="${REPORT_DIR}/browser-farm-certification-summary.json"
node --input-type=module - "${CERTIFICATION_SUMMARY_PATH}" "${REPORT_DIR}" "${MODE}" "${WORKER_CAPACITY}" "${RUN_CALIBRATION}" "${CALIBRATION_STAGES}" "${CALIBRATION_SUMMARY:-}" "${MOBILE_RATIO_VALUE}" "${STAGES_CSV}" "${MERGED_PATHS[*]}" <<'NODE'
import fs from 'node:fs';
const [
  outputPath,
  reportDir,
  mode,
  workerCapacityRaw,
  runCalibrationRaw,
  calibrationStagesRaw,
  calibrationSummaryPath,
  mobileRatioRaw,
  requestedStagesRaw,
  mergedPathsRaw,
] = process.argv.slice(2);

const workerCapacity = Number(workerCapacityRaw || 0);
const runCalibration = String(runCalibrationRaw || '') === '1';
const requestedStages = String(requestedStagesRaw || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const mergedPaths = String(mergedPathsRaw || '')
  .split(' ')
  .map((value) => value.trim())
  .filter(Boolean);
const stageResults = mergedPaths.map((filePath) => {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    stage: Number(payload.stage || 0),
    ok: Boolean(payload.ok),
    successCount: Number(payload.successCount || 0),
    failureCount: Number(payload.failureCount || 0),
    manifestFailures: Number(payload.manifestFailures || 0),
    segmentFailures: Number(payload.segmentFailures || 0),
    playbackConflicts: Number(payload.playbackConflicts || 0),
    failureBreakdown: payload.failureBreakdown || {},
    summaryPath: filePath,
  };
});
const firstFailure = stageResults.find((entry) => !entry.ok) || null;
const exactRealBrowserCount = stageResults.reduce((max, entry) => (
  entry.ok ? Math.max(max, Number(entry.stage || 0)) : max
), 0);
const requiredStage = requestedStages.length ? Math.max(...requestedStages) : 0;
const requiredStageResult = stageResults.find((entry) => Number(entry.stage || 0) === requiredStage) || null;
const requiredStagePassed = Boolean(requiredStageResult?.ok);
const allStagesPassed = stageResults.length > 0 && stageResults.every((entry) => entry.ok);
const blockingFailures = [];
if (!allStagesPassed) {
  blockingFailures.push('stage_failure');
}
if (!requiredStagePassed) {
  blockingFailures.push(`required_stage_${requiredStage}_not_passed`);
}
if (mode === 'video') {
  if (stageResults.some((entry) => Number(entry.manifestFailures || 0) > 0)) {
    blockingFailures.push('valid_user_manifest_failures_present');
  }
  if (stageResults.some((entry) => Number(entry.segmentFailures || 0) > 0)) {
    blockingFailures.push('valid_user_segment_failures_present');
  }
  if (stageResults.some((entry) => Number(entry.playbackConflicts || 0) > 0)) {
    blockingFailures.push('playback_conflicts_present');
  }
}

const summary = {
  mode,
  reportDir,
  requestedStages,
  exactRealBrowserCount,
  exactSyntheticDiagnosticCount: 0,
  allUsersRealBrowsers: true,
  workerCapacity,
  runCalibration,
  calibrationStages: calibrationStagesRaw,
  calibrationSummaryPath: calibrationSummaryPath || null,
  mobileRatio: Number(mobileRatioRaw || 0),
  overallOk: allStagesPassed,
  requiredStage,
  requiredStagePassed,
  firstFailure,
  stageResults,
  blockingFailures,
  finalVerdict: allStagesPassed && requiredStagePassed ? 'passed' : 'blocked',
  eligibleForManualProductionApproval: mode === 'video' && allStagesPassed && requiredStagePassed,
  deployApproved: false,
};

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
NODE

echo "[browser-farm] certification summary: ${CERTIFICATION_SUMMARY_PATH}"
echo "[browser-farm] ${MODE} ladder complete"
