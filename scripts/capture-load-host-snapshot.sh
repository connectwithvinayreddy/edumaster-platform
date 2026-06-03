#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 4 ]]; then
  echo "Usage: $0 <report-dir> <label> <ssh-target> <base-url> [compose-project]" >&2
  exit 1
fi

REPORT_DIR="$1"
LABEL="$2"
SSH_TARGET="$3"
BASE_URL="$4"
COMPOSE_PROJECT="${5:-}"
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
SNAPSHOT_DIR="${REPORT_DIR}/host-snapshots/${LABEL}-${RUN_ID}"

mkdir -p "${SNAPSHOT_DIR}"

run_remote_capture() {
  local file_name="$1"
  local remote_command="$2"
  if ! ssh -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_TARGET}" "${remote_command}" > "${SNAPSHOT_DIR}/${file_name}" 2>&1; then
    echo "command_failed" >> "${SNAPSHOT_DIR}/${file_name}"
  fi
}

if [[ -n "${COMPOSE_PROJECT}" ]]; then
  REMOTE_FILTER="--filter label=com.docker.compose.project=${COMPOSE_PROJECT}"
else
  REMOTE_FILTER=""
fi

run_remote_capture "hostname.txt" "hostname"
run_remote_capture "cpu.txt" "nproc"
run_remote_capture "memory.txt" "free -h"
run_remote_capture "disk.txt" "df -h"
run_remote_capture "uptime.txt" "uptime"
run_remote_capture "vmstat.txt" "vmstat 1 2"
run_remote_capture "docker-ps.jsonl" "docker ps -a ${REMOTE_FILTER} --format '{{json .}}'"
run_remote_capture "docker-stats.jsonl" "docker stats --no-stream ${REMOTE_FILTER} --format '{{json .}}'"

{
  printf '/ %s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE_URL}/" || true)"
  printf '/backend/api/live %s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE_URL}/backend/api/live" || true)"
  printf '/backend/api/ready %s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE_URL}/backend/api/ready" || true)"
  printf '/backend/api/health %s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE_URL}/backend/api/health" || true)"
} > "${SNAPSHOT_DIR}/public-endpoints.txt"

node - "${SNAPSHOT_DIR}" "${LABEL}" "${SSH_TARGET}" "${BASE_URL}" "${COMPOSE_PROJECT}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [snapshotDir, label, sshTarget, baseUrl, composeProject] = process.argv.slice(2);

const readText = (name) => {
  const filePath = path.join(snapshotDir, name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
};

const parseJsonLines = (name) => {
  const text = readText(name);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};

const parsePercent = (value) => {
  if (!value) return null;
  const numeric = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
};

const endpointStatuses = readText('public-endpoints.txt')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [endpoint, status] = line.trim().split(/\s+/);
    return {
      endpoint,
      status: Number(status),
      ok: Number(status) >= 200 && Number(status) < 300,
    };
  });

const containers = parseJsonLines('docker-ps.jsonl');
const stats = parseJsonLines('docker-stats.jsonl').map((entry) => ({
  name: entry.Name || entry.Container || null,
  cpuPercent: parsePercent(entry.CPUPerc),
  memPercent: parsePercent(entry.MemPerc),
  memUsage: entry.MemUsage || null,
  netIO: entry.NetIO || null,
  pids: entry.PIDs || null,
}));

const restartingContainers = containers
  .filter((entry) => /restarting/i.test(String(entry.Status || '')))
  .map((entry) => String(entry.Names || entry.Name || 'unknown'));

const unhealthyContainers = containers
  .filter((entry) => /(unhealthy|dead|exited)/i.test(String(entry.Status || '')))
  .map((entry) => String(entry.Names || entry.Name || 'unknown'));

const highCpuContainers = stats
  .filter((entry) => typeof entry.cpuPercent === 'number' && entry.cpuPercent >= 85)
  .map((entry) => entry.name);

const highMemContainers = stats
  .filter((entry) => typeof entry.memPercent === 'number' && entry.memPercent >= 85)
  .map((entry) => entry.name);

const summary = {
  capturedAt: new Date().toISOString(),
  label,
  sshTarget,
  baseUrl,
  composeProject: composeProject || null,
  artifactDir: snapshotDir,
  hostname: readText('hostname.txt').trim() || null,
  cpuCount: Number(readText('cpu.txt').trim()) || null,
  containerCount: containers.length,
  restartingContainers,
  unhealthyContainers,
  highCpuContainers,
  highMemContainers,
  endpointStatuses,
  artifactPaths: {
    hostname: path.join(snapshotDir, 'hostname.txt'),
    cpu: path.join(snapshotDir, 'cpu.txt'),
    memory: path.join(snapshotDir, 'memory.txt'),
    disk: path.join(snapshotDir, 'disk.txt'),
    uptime: path.join(snapshotDir, 'uptime.txt'),
    vmstat: path.join(snapshotDir, 'vmstat.txt'),
    dockerPs: path.join(snapshotDir, 'docker-ps.jsonl'),
    dockerStats: path.join(snapshotDir, 'docker-stats.jsonl'),
    publicEndpoints: path.join(snapshotDir, 'public-endpoints.txt'),
  },
};

fs.writeFileSync(path.join(snapshotDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(path.join(snapshotDir, 'summary.json'));
NODE
