#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
CADDYFILE_PATH="${SCRIPT_DIR}/Caddyfile"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-2}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-240}"
PUBLIC_MONITOR_LOG="${PUBLIC_MONITOR_LOG:-/tmp/edumaster-safe-deploy-public-checks.log}"
SCRIPT_START_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PLAYBACK_DEPLOY_GATE_ENFORCED="${PLAYBACK_DEPLOY_GATE_ENFORCED:-0}"
PLAYBACK_DEPLOY_GATE_SUMMARY="${PLAYBACK_DEPLOY_GATE_SUMMARY:-}"
PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL="${PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL:-}"
PLAYBACK_DEPLOY_REQUIRED_STAGE="${PLAYBACK_DEPLOY_REQUIRED_STAGE:-2000}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] missing env file: ${ENV_FILE}" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

STACK_ENV_FILE_PATH="${STACK_ENV_FILE_PATH:-${ENV_FILE}}"
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME:-$(read_env_value COMPOSE_PROJECT_NAME)}"
if [[ -z "${COMPOSE_PROJECT_NAME_VALUE}" ]]; then
  COMPOSE_PROJECT_NAME_VALUE="$(read_env_value SERVICE_NAME)"
fi
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-edumaster-lowcost}"
APP_DOMAIN="${APP_DOMAIN:-$(read_env_value APP_DOMAIN)}"

if [[ -z "${APP_DOMAIN}" ]]; then
  echo "[deploy] APP_DOMAIN is not set in ${ENV_FILE}" >&2
  exit 1
fi

export STACK_ENV_FILE_PATH
COMPOSE=(docker compose -p "${COMPOSE_PROJECT_NAME_VALUE}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
PUBLIC_BASE="https://${APP_DOMAIN}"
PUBLIC_ENDPOINTS=(
  "${PUBLIC_BASE}/"
  "${PUBLIC_BASE}/backend/api/live"
  "${PUBLIC_BASE}/backend/api/ready"
  "${PUBLIC_BASE}/backend/api/health"
)

monitor_pid=""

cleanup() {
  if [[ -n "${monitor_pid}" ]] && kill -0 "${monitor_pid}" 2>/dev/null; then
    kill "${monitor_pid}" 2>/dev/null || true
    wait "${monitor_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

print_status() {
  echo "[deploy] current compose status"
  "${COMPOSE[@]}" ps
}

reload_caddy() {
  local container_id
  container_id="$(service_container_id caddy)"
  if [[ -n "${container_id}" ]]; then
    echo "[deploy] reloading caddy with current config"
    docker exec "${container_id}" caddy reload --config /etc/edumaster-caddy/Caddyfile >/dev/null
  fi
}

write_app_upstreams() {
  local upstreams="$1"
  local block_file
  block_file="$(mktemp)"
  cat > "${block_file}" <<EOF
    # BEGIN_APP_UPSTREAMS
reverse_proxy ${upstreams} {
  health_uri /api/ready
  health_interval 5s
  health_timeout 2s
  health_status 200
  lb_retries 3
  lb_try_duration 10s
  lb_try_interval 250ms
  fail_duration 30s
  max_fails 2
  unhealthy_status 502 503 504
}
    # END_APP_UPSTREAMS
EOF
  python3 - "${CADDYFILE_PATH}" "${block_file}" <<'PY'
from pathlib import Path
import re
import sys

caddyfile = Path(sys.argv[1])
block = Path(sys.argv[2]).read_text()
text = caddyfile.read_text()
updated, count = re.subn(
    r"    # BEGIN_APP_UPSTREAMS\n.*?    # END_APP_UPSTREAMS",
    block.rstrip(),
    text,
    flags=re.S,
)
if count != 1:
    raise SystemExit("failed to replace app upstream block in Caddyfile")
caddyfile.write_text(updated + ("\n" if not updated.endswith("\n") else ""))
PY
  rm -f "${block_file}"
  reload_caddy
}

monitor_public_endpoints() {
  : > "${PUBLIC_MONITOR_LOG}"
  while true; do
    local ts
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    for url in "${PUBLIC_ENDPOINTS[@]}"; do
      local status
      status="$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 "${url}" || true)"
      echo "${ts} ${status} ${url}" >> "${PUBLIC_MONITOR_LOG}"
    done
    sleep "${CHECK_INTERVAL_SECONDS}"
  done
}

start_public_monitor() {
  echo "[deploy] monitoring public endpoints during rollout -> ${PUBLIC_MONITOR_LOG}"
  monitor_public_endpoints &
  monitor_pid="$!"
}

assert_public_monitor_clean() {
  local bad
  bad="$(awk '$2 !~ /^2[0-9][0-9]$/ { print }' "${PUBLIC_MONITOR_LOG}" || true)"
  if [[ -n "${bad}" ]]; then
    echo "[deploy] public endpoint failures detected during rollout:" >&2
    echo "${bad}" >&2
    return 1
  fi
}

build_images() {
  echo "[deploy] building updated images before rollout"
  "${COMPOSE[@]}" build app app-2 manifest-app manifest-app-2 watch-worker replay-importer
}

verify_playback_deploy_gate() {
  if [[ ! "${PLAYBACK_DEPLOY_GATE_ENFORCED}" =~ ^(1|true|yes|on)$ ]]; then
    return 0
  fi

  echo "[deploy] enforcing protected-HLS playback deploy gate"
  (
    cd "${ROOT_DIR}"
    PLAYBACK_DEPLOY_GATE_SUMMARY="${PLAYBACK_DEPLOY_GATE_SUMMARY}" \
    PLAYBACK_DEPLOY_REQUIRED_STAGE="${PLAYBACK_DEPLOY_REQUIRED_STAGE}" \
    PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL="${PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL}" \
    node ./scripts/verify-playback-deploy-gate.mjs
  )
}

service_container_id() {
  local service="$1"
  "${COMPOSE[@]}" ps -q "${service}"
}

container_health() {
  local container_id="$1"
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}"
}

wait_for_service_health() {
  local service="$1"
  local timeout="${2:-${HEALTH_TIMEOUT_SECONDS}}"
  local deadline=$((SECONDS + timeout))
  local container_id=""
  local health=""

  while (( SECONDS < deadline )); do
    container_id="$(service_container_id "${service}")"
    if [[ -n "${container_id}" ]]; then
      health="$(container_health "${container_id}" 2>/dev/null || true)"
      if [[ "${health}" == "healthy" ]]; then
        echo "[deploy] ${service} docker health is healthy (${container_id})"
        return 0
      fi
      echo "[deploy] waiting for ${service} health -> ${health:-unknown}"
    else
      echo "[deploy] waiting for ${service} container to appear"
    fi
    sleep 5
  done

  echo "[deploy] ${service} failed to become healthy within ${timeout}s" >&2
  return 1
}

exec_service_http_check() {
  local service="$1"
  local url="$2"
  "${COMPOSE[@]}" exec -T "${service}" node -e "fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" "${url}"
}

wait_for_service_readiness() {
  local service="$1"
  local timeout="${2:-${HEALTH_TIMEOUT_SECONDS}}"
  local deadline=$((SECONDS + timeout))

  wait_for_service_health "${service}" "${timeout}"

  while (( SECONDS < deadline )); do
    if exec_service_http_check "${service}" "http://127.0.0.1:5000/api/live" \
      && exec_service_http_check "${service}" "http://127.0.0.1:5000/api/ready" \
      && exec_service_http_check "${service}" "http://127.0.0.1:5000/api/health"; then
      echo "[deploy] ${service} passed internal live/ready/health checks"
      return 0
    fi
    echo "[deploy] waiting for ${service} internal readiness"
    sleep 5
  done

  echo "[deploy] ${service} failed internal readiness checks within ${timeout}s" >&2
  return 1
}

roll_service() {
  local service="$1"
  local standby_upstreams="app:5000 app-2:5000"

  if [[ "${service}" == "app" ]]; then
    standby_upstreams="app-2:5000"
  elif [[ "${service}" == "app-2" ]]; then
    standby_upstreams="app:5000"
  fi

  echo "[deploy] rolling ${service}"
  if [[ "${service}" == "app" || "${service}" == "app-2" ]]; then
    echo "[deploy] draining ${service} from caddy upstreams"
    write_app_upstreams "${standby_upstreams}"
  fi
  "${COMPOSE[@]}" up -d --build --no-deps "${service}"
  wait_for_service_readiness "${service}"
  if [[ "${service}" == "app" || "${service}" == "app-2" ]]; then
    echo "[deploy] restoring dual app upstreams in caddy"
    write_app_upstreams "app:5000 app-2:5000"
  fi
}

verify_public_endpoints() {
  echo "[deploy] verifying public endpoints"
  for url in "${PUBLIC_ENDPOINTS[@]}"; do
    local status
    status="$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${url}")"
    echo "[deploy] ${status} ${url}"
    if [[ ! "${status}" =~ ^2[0-9][0-9]$ ]]; then
      echo "[deploy] public endpoint check failed for ${url}" >&2
      return 1
    fi
  done
}

check_logs_clean() {
  echo "[deploy] checking recent proxy logs for upstream failures"
  local caddy_container_id
  caddy_container_id="$(service_container_id caddy)"
  if [[ -z "${caddy_container_id}" ]]; then
    echo "[deploy] caddy container is not running for compose project ${COMPOSE_PROJECT_NAME_VALUE}" >&2
    return 1
  fi
  local recent_logs
  recent_logs="$(
    docker logs --since "${SCRIPT_START_UTC}" "${caddy_container_id}" 2>&1 \
      | grep -E 'no upstreams|connection refused|server misbehaving|reverseproxy\.statusError|lookup .*127\.0\.0\.11|dial tcp|upstream.*unavailable|502 |503 |504 |525 ' \
      | grep -v 'setting HTTP/3 Alt-Svc header' \
      || true
  )"
  if [[ -n "${recent_logs}" ]]; then
    echo "[deploy] warning: recent caddy error patterns found:" >&2
    echo "${recent_logs}" >&2
    return 1
  fi
}

main() {
  verify_playback_deploy_gate
  print_status
  write_app_upstreams "app:5000 app-2:5000"
  build_images
  start_public_monitor

  roll_service app
  roll_service app-2

  cleanup
  monitor_pid=""

  verify_public_endpoints
  assert_public_monitor_clean
  check_logs_clean
  print_status
  echo "[deploy] safe rolling production deploy completed successfully"
}

main "$@"
