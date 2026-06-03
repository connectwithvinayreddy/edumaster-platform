#!/usr/bin/env bash
set -euo pipefail

STAGING_SSH_TARGET="${1:-}"
STAGING_REMOTE_DIR="${2:-${STAGING_REMOTE_DIR:-/opt/edumaster-staging}}"
CONFIGURE_UFW_VALUE="${CONFIGURE_UFW:-0}"
OPEN_LIVE_PORT_VALUE="${OPEN_LIVE_PORT:-0}"

if [[ -z "${STAGING_SSH_TARGET}" ]]; then
  echo "Usage: $0 <user@staging-host> [remote-dir]" >&2
  exit 1
fi

ssh "${STAGING_SSH_TARGET}" bash -s -- \
  "${STAGING_REMOTE_DIR}" \
  "${CONFIGURE_UFW_VALUE}" \
  "${OPEN_LIVE_PORT_VALUE}" <<'REMOTE'
set -euo pipefail

remote_dir="$1"
configure_ufw="$2"
open_live_port="$3"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release rsync

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  if [[ ! -f /etc/apt/sources.list.d/docker.list ]]; then
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
  fi
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable docker
systemctl start docker

mkdir -p "${remote_dir}/backups"

if [[ "${configure_ufw}" == "1" ]]; then
  apt-get install -y ufw
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  if [[ "${open_live_port}" == "1" ]]; then
    ufw allow 1935/tcp
  fi
  ufw --force enable
fi

echo "[staging-bootstrap] docker: $(docker --version)"
echo "[staging-bootstrap] compose: $(docker compose version)"
echo "[staging-bootstrap] remote dir prepared: ${remote_dir}"
REMOTE
