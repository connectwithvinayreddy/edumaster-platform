#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.production}"
QA_BASE_URL_VALUE="${QA_BASE_URL:-}"
TARGETS_FILE_VALUE="${QA_STREAM_CERT_TARGETS_FILE:-${ROOT_DIR}/qa-automation/stream-cert-targets.example.json}"
RUN_WATCH_LIMIT_VALUE="${RUN_WATCH_LIMIT:-1}"
PROOF_SCOPE="${PROOF_SCOPE:-functional}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
REPORT_DIR="${ROOT_DIR}/reports/targeted-functional-proof-${PROOF_SCOPE}-${RUN_ID}"
TARGET_SUMMARY_JSONL="${REPORT_DIR}/targets.jsonl"

mkdir -p "${REPORT_DIR}"

is_placeholder_value() {
  local value="${1:-}"
  local placeholder_pattern='^(replace-with-|your-|example\.com|example\.net|placeholder|<[^>]+>)'
  [[ "${value}" =~ ${placeholder_pattern} ]]
}

if [[ ! -f "${TARGETS_FILE_VALUE}" ]]; then
  echo "[targeted-proof] target manifest missing: ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

if [[ -f "${ENV_FILE_PATH}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE_PATH}"
  set +a
fi

QA_BASE_URL_VALUE="${QA_BASE_URL_VALUE:-${APP_URL:-}}"
if [[ -z "${QA_BASE_URL_VALUE}" ]]; then
  echo "[targeted-proof] QA_BASE_URL is required." >&2
  exit 1
fi

latest_rootcause_summary() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-playback-rootcause.json' -print 2>/dev/null | sort | tail -n 1
}

latest_watch_limit_report() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/report.json' -print 2>/dev/null | grep 'course-watch-limit-regression-' | sort | tail -n 1
}

latest_pdf_smoke_summary() {
  find "${ROOT_DIR}/qa-automation/artifacts" -path '*/analysis/course-pdf-editorial-smoke.json' -print 2>/dev/null | sort | tail -n 1
}

encoded_targets=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  encoded_targets+=("${line}")
done < <(node - "${TARGETS_FILE_VALUE}" "${QA_STREAM_CERT_TARGET_KEY:-}" "${QA_STREAM_CERT_TARGET_INDEX:-}" <<'NODE'
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
  echo "[targeted-proof] no targets selected from ${TARGETS_FILE_VALUE}" >&2
  exit 1
fi

for encoded_target in "${encoded_targets[@]}"; do
  target_fields=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    target_fields+=("${line}")
  done < <(node - "${encoded_target}" <<'NODE'
const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
process.stdout.write([
  String(payload.key || ''),
  String(payload.courseId || ''),
  String(payload.courseText || ''),
  String(payload.lessonId || ''),
  String(payload.lessonText || ''),
  String(payload.pdfAttachmentId || ''),
  String(payload.pdfAttachmentTitle || ''),
].join('\n'));
NODE
  )

  target_key="${target_fields[0]:-}"
  course_id="${target_fields[1]:-}"
  course_text="${target_fields[2]:-}"
  lesson_id="${target_fields[3]:-}"
  lesson_text="${target_fields[4]:-}"
  pdf_attachment_id="${target_fields[5]:-}"
  pdf_attachment_title="${target_fields[6]:-}"

  manifest_path="${REPORT_DIR}/${target_key}-prepared-user.json"
  prepare_log="${REPORT_DIR}/${target_key}-prepare-user.log"

  (
    cd "${ROOT_DIR}"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_COURSE_ID="${course_id}" \
    QA_VIDEO_BROWSER_MANIFEST_USERS=1 \
    QA_VIDEO_BROWSER_MANIFEST_PATH="${manifest_path}" \
    QA_VIDEO_BROWSER_USER_PREFIX="qa.targeted.proof.${PROOF_SCOPE}.${target_key}." \
    npm --prefix qa-automation run browser:prepare-video-browser-manifest
  ) > "${prepare_log}" 2>&1

  prepared_user=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    prepared_user+=("${line}")
  done < <(node - "${manifest_path}" <<'NODE'
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

  login_email="${prepared_user[0]:-}"
  if [[ -z "${login_email}" ]]; then
    echo "[targeted-proof] failed to prepare a QA user for ${target_key}" >&2
    exit 1
  fi

  preflight_log="${REPORT_DIR}/${target_key}-preflight.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_STREAM_CERT_TARGETS_FILE="${TARGETS_FILE_VALUE}" \
    QA_STREAM_CERT_TARGET_KEY="${target_key}" \
    QA_STREAM_CERT_PREPARED_USERS_FILE="${manifest_path}" \
    npm --prefix qa-automation run browser:stream-cert-preflight
  ) > "${preflight_log}" 2>&1

  pdf_log=""
  pdf_summary_path=""
  if [[ -n "${pdf_attachment_id}" ]] && ! is_placeholder_value "${pdf_attachment_id}"; then
    pdf_log="${REPORT_DIR}/${target_key}-pdf-smoke.log"
    (
      cd "${ROOT_DIR}"
      ENV_FILE="${ENV_FILE_PATH}" \
      QA_BASE_URL="${QA_BASE_URL_VALUE}" \
      QA_LOGIN_EMAIL="${login_email}" \
      QA_LOGIN_PASSWORD="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}" \
      QA_COURSE_ID="${course_id}" \
      QA_COURSE_TEXT="${course_text}" \
      QA_PDF_ATTACHMENT_ID="${pdf_attachment_id}" \
      QA_PDF_ATTACHMENT_TITLE="${pdf_attachment_title}" \
      npm --prefix qa-automation run browser:course-pdf-editorial
    ) > "${pdf_log}" 2>&1
    pdf_summary_path="$(latest_pdf_smoke_summary)"
  else
    echo "[targeted-proof] skipping PDF smoke for ${target_key}: no concrete pdfAttachmentId configured" >> "${REPORT_DIR}/notes.log"
  fi

  desktop_log="${REPORT_DIR}/${target_key}-desktop-rootcause.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_LOGIN_EMAIL="${login_email}" \
    QA_LOGIN_PASSWORD="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}" \
    QA_COURSE_ID="${course_id}" \
    QA_COURSE_TEXT="${course_text}" \
    QA_LESSON_ID="${lesson_id}" \
    QA_LESSON_TEXT="${lesson_text}" \
    npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
  ) > "${desktop_log}" 2>&1
  desktop_summary_path="$(latest_rootcause_summary)"

  mobile_log="${REPORT_DIR}/${target_key}-mobile-rootcause.log"
  (
    cd "${ROOT_DIR}"
    ENV_FILE="${ENV_FILE_PATH}" \
    QA_BASE_URL="${QA_BASE_URL_VALUE}" \
    QA_LOGIN_EMAIL="${login_email}" \
    QA_LOGIN_PASSWORD="${PLATFORM_LOAD_USER_PASSWORD:-${QA_LOGIN_PASSWORD:-Student@123}}" \
    QA_COURSE_ID="${course_id}" \
    QA_COURSE_TEXT="${course_text}" \
    QA_LESSON_ID="${lesson_id}" \
    QA_LESSON_TEXT="${lesson_text}" \
    QA_MOBILE_MODE=true \
    npm --prefix qa-automation run browser:video-auto-back-rootcause-regression
  ) > "${mobile_log}" 2>&1
  mobile_summary_path="$(latest_rootcause_summary)"

  watch_limit_log=""
  watch_limit_summary_path=""
  if [[ "${RUN_WATCH_LIMIT_VALUE}" == "1" ]]; then
    watch_limit_log="${REPORT_DIR}/${target_key}-watch-limit.log"
    (
      cd "${ROOT_DIR}"
      ENV_FILE="${ENV_FILE_PATH}" \
      QA_BASE_URL="${QA_BASE_URL_VALUE}" \
      QA_WATCH_LIMIT_COURSE_ID="${course_id}" \
      QA_WATCH_LIMIT_COURSE_TEXT="${course_text}" \
      QA_WATCH_LIMIT_LESSON_ID="${lesson_id}" \
      QA_WATCH_LIMIT_LESSON_TEXT="${lesson_text}" \
      QA_AUTOMATION_CLEANUP_MODE=execute \
      npm --prefix qa-automation run browser:video-false-completion-after-pause-powercut-regression
    ) > "${watch_limit_log}" 2>&1
    watch_limit_summary_path="$(latest_watch_limit_report)"
  fi

  node - "${target_key}" "${course_id}" "${course_text}" "${lesson_id}" "${lesson_text}" "${pdf_attachment_id}" "${pdf_attachment_title}" "${manifest_path}" "${preflight_log}" "${pdf_log}" "${pdf_summary_path}" "${desktop_log}" "${desktop_summary_path}" "${mobile_log}" "${mobile_summary_path}" "${watch_limit_log}" "${watch_limit_summary_path}" >> "${TARGET_SUMMARY_JSONL}" <<'NODE'
const [
  targetKey,
  courseId,
  courseText,
  lessonId,
  lessonText,
  pdfAttachmentId,
  pdfAttachmentTitle,
  manifestPath,
  preflightLog,
  pdfLog,
  pdfSummaryPath,
  desktopLog,
  desktopSummaryPath,
  mobileLog,
  mobileSummaryPath,
  watchLimitLog,
  watchLimitSummaryPath,
] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  key: targetKey,
  courseId,
  courseText,
  lessonId,
  lessonText,
  pdfAttachmentId,
  pdfAttachmentTitle: pdfAttachmentTitle || null,
  manifestPath,
  logs: {
    preflight: preflightLog,
    pdfSmoke: pdfLog,
    desktopRootcause: desktopLog,
    mobileRootcause: mobileLog,
    watchLimit: watchLimitLog || null,
  },
  summaries: {
    pdfSmoke: pdfSummaryPath,
    desktopRootcause: desktopSummaryPath,
    mobileRootcause: mobileSummaryPath,
    watchLimit: watchLimitSummaryPath || null,
  },
})}\n`);
NODE
done

SUMMARY_PATH="${REPORT_DIR}/targeted-functional-proof-summary.json"
node - "${SUMMARY_PATH}" "${PROOF_SCOPE}" "${QA_BASE_URL_VALUE}" "${ENV_FILE_PATH}" "${RUN_WATCH_LIMIT_VALUE}" "${TARGET_SUMMARY_JSONL}" <<'NODE'
const fs = require('node:fs');
const [outputPath, proofScope, baseUrl, envFile, runWatchLimitValue, jsonlPath] = process.argv.slice(2);
const targets = fs.readFileSync(jsonlPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const summary = {
  ok: true,
  proofScope,
  baseUrl,
  envFile,
  runWatchLimit: runWatchLimitValue === '1',
  targetCount: targets.length,
  targets,
};
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
NODE
