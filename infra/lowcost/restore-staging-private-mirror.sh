#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/lowcost/docker-compose.prod.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.staging.private-mirror}"
STACK_ENV_FILE_PATH="${STACK_ENV_FILE_PATH:-${ENV_FILE}}"
BACKUP_PATH="${1:-}"
KEEP_LIVE_CLASSES="${STAGING_KEEP_LIVE_CLASSES:-false}"
START_STACK_AFTER_RESTORE="${START_STACK_AFTER_RESTORE:-true}"
POSTGRES_START_TIMEOUT_SECONDS="${POSTGRES_START_TIMEOUT_SECONDS:-120}"

if [[ -z "${BACKUP_PATH}" ]]; then
  echo "Usage: ENV_FILE=.env.staging.private-mirror $0 /absolute/path/to/production-backup.{sql|sql.gz|dump|backup|dump.gz|backup.gz}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[staging-restore] env file missing: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${BACKUP_PATH}" ]]; then
  echo "[staging-restore] backup file missing: ${BACKUP_PATH}" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

read_prod_env_value() {
  local key="$1"
  local prod_env_path="${ROOT_DIR}/.env.production"
  if [[ ! -f "${prod_env_path}" ]]; then
    return
  fi
  grep -E "^${key}=" "${prod_env_path}" | tail -n 1 | cut -d= -f2- || true
}

assert_staging_restore_target() {
  local env_label
  local app_domain
  local live_domain
  local postgres_url
  local redis_url
  local prod_app_domain
  local prod_live_domain
  local prod_postgres_url
  local prod_redis_url

  env_label="$(read_env_value ENVIRONMENT_LABEL)"
  app_domain="$(read_env_value APP_DOMAIN)"
  live_domain="$(read_env_value LIVE_DOMAIN)"
  postgres_url="$(read_env_value POSTGRES_URL)"
  redis_url="$(read_env_value REDIS_URL)"
  prod_app_domain="$(read_prod_env_value APP_DOMAIN)"
  prod_live_domain="$(read_prod_env_value LIVE_DOMAIN)"
  prod_postgres_url="$(read_prod_env_value POSTGRES_URL)"
  prod_redis_url="$(read_prod_env_value REDIS_URL)"

  if [[ "${ENV_FILE}" == *".env.production" ]]; then
    echo "[staging-restore] refusing to run with a production env file: ${ENV_FILE}" >&2
    exit 1
  fi

  if [[ "${env_label}" != "staging-private-mirror" ]]; then
    echo "[staging-restore] ENVIRONMENT_LABEL must be staging-private-mirror, got: ${env_label:-<missing>}" >&2
    exit 1
  fi

  if [[ "${app_domain}" != *.nip.io || "${live_domain}" != *.nip.io ]]; then
    echo "[staging-restore] APP_DOMAIN and LIVE_DOMAIN must be nip.io staging hosts. Got APP_DOMAIN=${app_domain:-<missing>} LIVE_DOMAIN=${live_domain:-<missing>}" >&2
    exit 1
  fi

  if [[ -n "${prod_app_domain}" && "${app_domain}" == "${prod_app_domain}" ]]; then
    echo "[staging-restore] APP_DOMAIN matches production; refusing to continue." >&2
    exit 1
  fi

  if [[ -n "${prod_live_domain}" && "${live_domain}" == "${prod_live_domain}" ]]; then
    echo "[staging-restore] LIVE_DOMAIN matches production; refusing to continue." >&2
    exit 1
  fi

  if [[ -n "${prod_postgres_url}" && -n "${postgres_url}" && "${postgres_url}" == "${prod_postgres_url}" ]]; then
    echo "[staging-restore] POSTGRES_URL matches production; refusing to continue." >&2
    exit 1
  fi

  if [[ -n "${prod_redis_url}" && -n "${redis_url}" && "${redis_url}" == "${prod_redis_url}" ]]; then
    echo "[staging-restore] REDIS_URL matches production; refusing to continue." >&2
    exit 1
  fi
}

COMPOSE_PROJECT_NAME_VALUE="$(read_env_value COMPOSE_PROJECT_NAME)"
if [[ -z "${COMPOSE_PROJECT_NAME_VALUE}" ]]; then
  COMPOSE_PROJECT_NAME_VALUE="$(read_env_value SERVICE_NAME)"
fi
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME_VALUE:-edumaster-staging-mirror}"

assert_staging_restore_target

POSTGRES_DB_VALUE="$(read_env_value POSTGRES_DB)"
POSTGRES_DB_VALUE="${POSTGRES_DB_VALUE:-edumaster}"
POSTGRES_USER_VALUE="$(read_env_value POSTGRES_USER)"
POSTGRES_USER_VALUE="${POSTGRES_USER_VALUE:-postgres}"

if [[ ! "${POSTGRES_DB_VALUE}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "[staging-restore] unsupported POSTGRES_DB value: ${POSTGRES_DB_VALUE}" >&2
  exit 1
fi

export STACK_ENV_FILE_PATH

compose() {
  docker compose \
    -p "${COMPOSE_PROJECT_NAME_VALUE}" \
    --env-file "${ENV_FILE}" \
    -f "${COMPOSE_FILE}" \
    "$@"
}

wait_for_postgres() {
  local attempt=0
  local max_attempts=$(( POSTGRES_START_TIMEOUT_SECONDS / 2 ))
  until compose exec -T postgres pg_isready -U "${POSTGRES_USER_VALUE}" -d postgres >/dev/null 2>&1; do
    attempt=$(( attempt + 1 ))
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      echo "[staging-restore] postgres did not become ready within ${POSTGRES_START_TIMEOUT_SECONDS}s" >&2
      exit 1
    fi
    sleep 2
  done
}

psql_db() {
  local database="$1"
  shift
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER_VALUE}" -d "${database}" "$@"
}

restore_sql_backup() {
  local source_path="$1"
  if [[ "${source_path}" == *.gz ]]; then
    local gzip_status=0
    local psql_status=0
    set +o pipefail
    gzip -dc "${source_path}" | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER_VALUE}" -d "${POSTGRES_DB_VALUE}"
    local statuses=("${PIPESTATUS[@]}")
    set -o pipefail
    gzip_status="${statuses[0]:-0}"
    psql_status="${statuses[1]:-0}"
    if [[ "${psql_status}" -ne 0 ]]; then
      return "${psql_status}"
    fi
    if [[ "${gzip_status}" -ne 0 && "${gzip_status}" -ne 2 ]]; then
      return "${gzip_status}"
    fi
    return
  fi
  cat "${source_path}" | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER_VALUE}" -d "${POSTGRES_DB_VALUE}"
}

restore_custom_backup() {
  local source_path="$1"
  local container_tmp="/tmp/edumaster-staging-restore.backup"
  if [[ "${source_path}" == *.gz ]]; then
    gzip -dc "${source_path}" \
      | compose exec -T postgres sh -lc "cat > '${container_tmp}' && pg_restore -v --no-owner --no-privileges -U '${POSTGRES_USER_VALUE}' -d '${POSTGRES_DB_VALUE}' '${container_tmp}' && rm -f '${container_tmp}'"
    return
  fi
  cat "${source_path}" \
    | compose exec -T postgres sh -lc "cat > '${container_tmp}' && pg_restore -v --no-owner --no-privileges -U '${POSTGRES_USER_VALUE}' -d '${POSTGRES_DB_VALUE}' '${container_tmp}' && rm -f '${container_tmp}'"
}

restore_backup() {
  local source_path="$1"
  case "${source_path}" in
    *.sql|*.sql.gz)
      restore_sql_backup "${source_path}"
      ;;
    *.dump|*.backup|*.dump.gz|*.backup.gz)
      restore_custom_backup "${source_path}"
      ;;
    *)
      echo "[staging-restore] unsupported backup file type: ${source_path}" >&2
      exit 1
      ;;
  esac
}

scrub_staging_database() {
  local live_classes_sql=""
  if [[ "${KEEP_LIVE_CLASSES,,}" != "true" ]]; then
    live_classes_sql=", 'live_classes'"
  fi

  psql_db "${POSTGRES_DB_VALUE}" <<SQL
DO \$\$
DECLARE
  truncate_targets TEXT;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ')
    INTO truncate_targets
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename = ANY(ARRAY[
      'lesson_doubt_messages',
      'lesson_doubt_threads',
      'lesson_reports',
      'notifications',
      'user_sessions',
      'device_activity',
      'admin_audit_logs',
      'referrals',
      'payments',
      'payment_webhooks',
      'subscriptions',
      'enrollments',
      'watch_history',
      'video_watch_states',
      'video_access_grants',
      'live_replay_access_grants',
      'test_attempts',
      'daily_quiz_attempts',
      'live_chat_messages',
      'users'${live_classes_sql}
    ]);

  IF truncate_targets IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || truncate_targets || ' RESTART IDENTITY CASCADE';
  END IF;
END
\$\$;
SQL
}

flush_staging_redis() {
  if ! compose ps redis >/dev/null 2>&1; then
    return
  fi
  compose exec -T redis sh -lc 'redis-cli -a "$REDIS_PASSWORD" FLUSHALL' >/dev/null
}

bootstrap_staging_admin() {
  compose run --rm --no-deps app node backend/scripts/bootstrap-staging-admin.mjs
}

echo "[staging-restore] stopping staging app stack"
compose down

echo "[staging-restore] starting isolated postgres and redis"
compose up -d postgres redis
wait_for_postgres

echo "[staging-restore] resetting database ${POSTGRES_DB_VALUE}"
psql_db postgres <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${POSTGRES_DB_VALUE}'
  AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${POSTGRES_DB_VALUE}";
CREATE DATABASE "${POSTGRES_DB_VALUE}";
SQL

echo "[staging-restore] restoring backup from ${BACKUP_PATH}"
restore_backup "${BACKUP_PATH}"

echo "[staging-restore] scrubbing production users, payments, sessions, and watch data"
scrub_staging_database

echo "[staging-restore] flushing staging redis"
flush_staging_redis

echo "[staging-restore] bootstrapping staging-only admin"
bootstrap_staging_admin

echo "[staging-restore] current staging user counts"
psql_db "${POSTGRES_DB_VALUE}" <<SQL
SELECT
  COUNT(*) FILTER (WHERE role = 'admin') AS admin_users,
  COUNT(*) FILTER (WHERE role <> 'admin') AS non_admin_users
FROM users;
SQL

if [[ "${START_STACK_AFTER_RESTORE,,}" == "true" ]]; then
  echo "[staging-restore] starting full staging stack"
  compose up -d
else
  echo "[staging-restore] leaving only postgres/redis running because START_STACK_AFTER_RESTORE=${START_STACK_AFTER_RESTORE}"
fi

echo "[staging-restore] completed successfully"
