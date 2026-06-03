#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_FILE_PATH="${STREAM_R2_PROOF_REPORT:-${ROOT_DIR}/reports/stream-r2-proof/latest/production-deploy-ready.json}"
STREAMING_CERT_FILE_PATH="${STREAMING_PDF_MIXED_CERT_REPORT:-${ROOT_DIR}/reports/streaming-pdf-mixed-certification/latest/streaming-pdf-mixed-certification-summary.json}"

if [[ ! -f "${PROOF_FILE_PATH}" ]]; then
  echo "[stream-r2-deploy] missing proof report: ${PROOF_FILE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${STREAMING_CERT_FILE_PATH}" ]]; then
  echo "[stream-r2-deploy] missing SSC/Bank streaming+PDF certification report: ${STREAMING_CERT_FILE_PATH}" >&2
  exit 1
fi

node - "${PROOF_FILE_PATH}" "${STREAMING_CERT_FILE_PATH}" <<'NODE'
const fs = require('node:fs');
const proofPath = process.argv[2];
const streamingCertPath = process.argv[3];
const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
const streamingCert = JSON.parse(fs.readFileSync(streamingCertPath, 'utf8'));

if (!proof?.readyForProductionDeploy) {
  throw new Error(`proof report is not deploy-ready: ${proofPath}`);
}

const reached = Number(proof?.fullCourse?.maxViewerStagePassed || 0);
if (reached < 100) {
  throw new Error(`proof report did not certify 100 viewers: ${reached}`);
}

if (!streamingCert?.readyForProductionDeploy) {
  throw new Error(`SSC/Bank streaming+PDF certification is not deploy-ready: ${streamingCertPath}`);
}

const executedTargetKeys = Array.isArray(streamingCert?.executedTargetKeys)
  ? streamingCert.executedTargetKeys.map((value) => String(value))
  : [];
for (const requiredTarget of ['ssc', 'bank']) {
  if (!executedTargetKeys.includes(requiredTarget)) {
    throw new Error(`SSC/Bank streaming+PDF certification is missing target ${requiredTarget}: ${streamingCertPath}`);
  }
}

const requiredBrowserStages = Array.isArray(streamingCert?.requiredBrowserStageCounts)
  ? streamingCert.requiredBrowserStageCounts.map((value) => Number(value))
  : [];
for (const stage of [100, 200]) {
  if (!requiredBrowserStages.includes(stage)) {
    throw new Error(`SSC/Bank streaming+PDF certification did not include required browser stage ${stage}: ${streamingCertPath}`);
  }
}

const requiredSyntheticStages = Array.isArray(streamingCert?.requiredSyntheticTotalUserStages)
  ? streamingCert.requiredSyntheticTotalUserStages.map((value) => Number(value))
  : [];
for (const stage of [1000, 2000]) {
  if (!requiredSyntheticStages.includes(stage)) {
    throw new Error(`SSC/Bank streaming+PDF certification did not include required synthetic stage ${stage}: ${streamingCertPath}`);
  }
}

const requiredSyntheticMix = streamingCert?.requiredSyntheticMix || {};
if (Number(requiredSyntheticMix?.totalUsers || 0) < 2000) {
  throw new Error(`SSC/Bank streaming+PDF certification did not require a 2000 total-user mixed stage: ${streamingCertPath}`);
}
if (Number(requiredSyntheticMix?.videoUsers || 0) < 1400) {
  throw new Error(`SSC/Bank streaming+PDF certification did not require at least 1400 video users in the 2k mixed stage: ${streamingCertPath}`);
}
if (Number(requiredSyntheticMix?.backgroundUsers || 0) < 600) {
  throw new Error(`SSC/Bank streaming+PDF certification did not require at least 600 background users in the 2k mixed stage: ${streamingCertPath}`);
}
if (Number(requiredSyntheticMix?.pdfUsers || 0) < 320 || Number(requiredSyntheticMix?.authUsers || 0) < 80 || Number(requiredSyntheticMix?.testUsers || 0) < 200) {
  throw new Error(`SSC/Bank streaming+PDF certification did not require the expected 2k mixed split (320 pdf, 80 auth, 200 test background users): ${streamingCertPath}`);
}
NODE

echo "[stream-r2-deploy] proof accepted: ${PROOF_FILE_PATH}"
echo "[stream-r2-deploy] SSC/Bank streaming+PDF certification accepted: ${STREAMING_CERT_FILE_PATH}"
exec bash "${ROOT_DIR}/infra/lowcost/safe-production-deploy.sh" "$@"
