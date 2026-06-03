#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_PATH="${1:-}"
ENV_FILE_PATH="${ENV_FILE_PATH:-${ENV_FILE:-${ROOT_DIR}/.env.production}}"
LOCAL_POSTGRES_URL_VALUE="${LOCAL_POSTGRES_URL:-${POSTGRES_URL:-}}"
KEEP_LIVE_CLASSES_VALUE="${LOCAL_KEEP_LIVE_CLASSES:-false}"

if [[ -z "${BACKUP_PATH}" || ! -f "${BACKUP_PATH}" ]]; then
  echo "Usage: LOCAL_POSTGRES_URL=postgresql://... $0 /absolute/path/to/production-backup.{sql|sql.gz|dump|backup|dump.gz|backup.gz}" >&2
  exit 1
fi

if [[ -f "${ENV_FILE_PATH}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE_PATH}"
  set +a
fi

LOCAL_POSTGRES_URL_VALUE="${LOCAL_POSTGRES_URL:-${LOCAL_POSTGRES_URL_VALUE:-${POSTGRES_URL:-postgresql://${USER}@127.0.0.1:15432/edumaster}}}"
export POSTGRES_URL="${LOCAL_POSTGRES_URL_VALUE}"

bash "${ROOT_DIR}/scripts/ensure-local-postgres.sh"

readarray -t postgres_meta < <(node - "${POSTGRES_URL}" <<'NODE'
const raw = process.argv[2];
const url = new URL(raw);
const databaseName = decodeURIComponent((url.pathname || '/edumaster').replace(/^\//, '') || 'edumaster');
url.pathname = '/postgres';
url.search = '';
console.log(url.toString());
console.log(databaseName);
NODE
)

POSTGRES_ADMIN_URL="${postgres_meta[0]:-}"
POSTGRES_DB_NAME="${postgres_meta[1]:-edumaster}"

if [[ -z "${POSTGRES_ADMIN_URL}" || -z "${POSTGRES_DB_NAME}" ]]; then
  echo "[local-restore] failed to resolve local Postgres admin URL from ${POSTGRES_URL}" >&2
  exit 1
fi

restore_sql_backup() {
  if [[ "${BACKUP_PATH}" == *.gz ]]; then
    gzip -dc "${BACKUP_PATH}" | psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1
    return
  fi
  cat "${BACKUP_PATH}" | psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1
}

restore_custom_backup() {
  local tmp_path
  tmp_path="$(mktemp "${ROOT_DIR}/tmp/local-private-mirror.XXXXXX.backup")"
  if [[ "${BACKUP_PATH}" == *.gz ]]; then
    gzip -dc "${BACKUP_PATH}" > "${tmp_path}"
  else
    cp "${BACKUP_PATH}" "${tmp_path}"
  fi
  pg_restore -v --no-owner --no-privileges -d "${POSTGRES_URL}" "${tmp_path}"
  rm -f "${tmp_path}"
}

restore_backup() {
  case "${BACKUP_PATH}" in
    *.sql|*.sql.gz)
      restore_sql_backup
      ;;
    *.dump|*.backup|*.dump.gz|*.backup.gz)
      restore_custom_backup
      ;;
    *)
      echo "[local-restore] unsupported backup file type: ${BACKUP_PATH}" >&2
      exit 1
      ;;
  esac
}

live_classes_sql=""
if [[ "${KEEP_LIVE_CLASSES_VALUE,,}" != "true" ]]; then
  live_classes_sql=", 'live_classes'"
fi

psql "${POSTGRES_ADMIN_URL}" -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${POSTGRES_DB_NAME}'
  AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${POSTGRES_DB_NAME}";
CREATE DATABASE "${POSTGRES_DB_NAME}";
SQL

restore_backup

psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1 <<SQL
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

if [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  POSTGRES_URL="${POSTGRES_URL}" ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" ADMIN_NAME="${ADMIN_NAME:-EduMaster Local Mirror Admin}" \
    node "${ROOT_DIR}/backend/scripts/bootstrap-staging-admin.mjs"
fi

psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1 <<SQL
SELECT
  COUNT(*) FILTER (WHERE role = 'admin') AS admin_users,
  COUNT(*) FILTER (WHERE role <> 'admin') AS non_admin_users
FROM users;
SQL
