import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;

const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
const adminName = String(process.env.ADMIN_NAME || 'EduMaster Staging Admin').trim();

if (!adminEmail || !adminPassword) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required.');
  process.exit(1);
}

const postgresUrl = String(
  process.env.POSTGRES_URL
  || `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@${process.env.POSTGRES_HOST || 'postgres'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'edumaster'}`,
).trim();

const pool = new Pool({
  connectionString: postgresUrl,
});

const main = async () => {
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const userId = `admin_${randomUUID().replace(/-/g, '')}`;
  const result = await pool.query(
    `
      INSERT INTO users (
        id,
        full_name,
        email,
        password_hash,
        role,
        account_status,
        status_note,
        device,
        active_session_id,
        badges,
        created_at,
        updated_at,
        disabled_at,
        blocked_at,
        last_login_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'admin',
        'active',
        'staging private mirror bootstrap admin',
        '{}'::jsonb,
        NULL,
        '[]'::jsonb,
        now(),
        now(),
        NULL,
        NULL,
        NULL
      )
      ON CONFLICT (email) DO UPDATE
      SET
        full_name = EXCLUDED.full_name,
        password_hash = EXCLUDED.password_hash,
        role = 'admin',
        account_status = 'active',
        status_note = EXCLUDED.status_note,
        device = '{}'::jsonb,
        active_session_id = NULL,
        badges = COALESCE(users.badges, '[]'::jsonb),
        disabled_at = NULL,
        blocked_at = NULL,
        updated_at = now()
      RETURNING id, full_name, email, role, account_status
    `,
    [userId, adminName, adminEmail, passwordHash],
  );

  console.log(JSON.stringify({
    ok: true,
    admin: result.rows[0] || null,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
