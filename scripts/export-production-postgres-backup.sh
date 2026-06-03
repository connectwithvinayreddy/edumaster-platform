#!/usr/bin/env bash
set -euo pipefail

PROD_SSH_TARGET="${1:-${PROD_SSH_TARGET:-root@178.105.48.179}}"
PROD_BACKUP_ROOT="${PROD_BACKUP_ROOT:-/var/backups/edumaster}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-lowcost-postgres-1}"
POSTGRES_DB="${POSTGRES_DB:-edumaster}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
DRY_RUN_VALUE="${DRY_RUN:-0}"

if [[ "${DRY_RUN_VALUE}" == "1" ]]; then
  cat <<EOF
ssh ${PROD_SSH_TARGET} '
  ts=\$(date -u +%Y-%m-%dT%H-%M-%SZ)
  dir=${PROD_BACKUP_ROOT}/\$ts
  file=\$dir/postgres.sql.gz
  mkdir -p "\$dir"
  docker exec ${POSTGRES_CONTAINER} pg_dump -U ${POSTGRES_USER} -d ${POSTGRES_DB} | gzip > "\$file"
  test -s "\$file"
  printf "%s\n" "\$file"
'
EOF
  exit 0
fi

ssh "${PROD_SSH_TARGET}" bash -s -- \
  "${PROD_BACKUP_ROOT}" \
  "${POSTGRES_CONTAINER}" \
  "${POSTGRES_USER}" \
  "${POSTGRES_DB}" <<'REMOTE'
set -euo pipefail

backup_root="$1"
postgres_container="$2"
postgres_user="$3"
postgres_db="$4"

ts="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
dir="${backup_root}/${ts}"
file="${dir}/postgres.sql.gz"

mkdir -p "${dir}"
docker exec "${postgres_container}" pg_dump -U "${postgres_user}" -d "${postgres_db}" | gzip > "${file}"
test -s "${file}"
printf '%s\n' "${file}"
REMOTE
