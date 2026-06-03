#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_PATH="${ENV_FILE:-${ROOT_DIR}/.env.production}"
QA_BASE_URL_VALUE="${QA_BASE_URL:-https://app.varonenglishapp.in}"

ENV_FILE="${ENV_FILE_PATH}" \
QA_BASE_URL="${QA_BASE_URL_VALUE}" \
RUN_WATCH_LIMIT=0 \
PROOF_SCOPE="production-smoke" \
bash "${ROOT_DIR}/scripts/run-targeted-functional-proof.sh"
