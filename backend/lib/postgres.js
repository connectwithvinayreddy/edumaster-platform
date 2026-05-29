const { Pool } = require('pg');
const { appConfig } = require('./config.js');

let pool = null;
let postgresReady = false;
let postgresInitPromise = null;

const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      mobile_number VARCHAR(20),
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'student',
      device JSONB,
      active_session_id TEXT,
      streak_days INT NOT NULL DEFAULT 0,
      reward_points INT NOT NULL DEFAULT 0,
      badges JSONB NOT NULL DEFAULT '[]'::jsonb,
      referral_code VARCHAR(32),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(20)`,
  `
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      jwt_session_id VARCHAR(120) NOT NULL,
      device JSONB,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      reason VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS device_activity (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      device JSONB,
      event_type VARCHAR(60) NOT NULL,
      event_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category VARCHAR(80) NOT NULL DEFAULT 'SSC JE',
      exam VARCHAR(80) NOT NULL DEFAULT 'SSC JE',
      subject VARCHAR(120) NOT NULL DEFAULT 'General',
      level VARCHAR(60) NOT NULL DEFAULT 'Full Course',
      price_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
      offer_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
      validity_days INT NOT NULL DEFAULT 365,
      thumbnail_url TEXT,
      instructor_name VARCHAR(120),
      official_channel_url TEXT,
      modules JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE courses ADD COLUMN IF NOT EXISTS offer_percentage NUMERIC(5,2) NOT NULL DEFAULT 0',
  `
    CREATE TABLE IF NOT EXISTS tests (
      id TEXT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category VARCHAR(80) NOT NULL DEFAULT 'SSC JE',
      test_type VARCHAR(40) NOT NULL DEFAULT 'full-length',
      duration_minutes INT NOT NULL DEFAULT 60,
      total_marks NUMERIC(8,2) NOT NULL DEFAULT 0,
      negative_marking NUMERIC(6,2) NOT NULL DEFAULT 0,
      course_id TEXT,
      companion_video JSONB,
      section_breakup JSONB NOT NULL DEFAULT '[]'::jsonb,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE tests ADD COLUMN IF NOT EXISTS companion_video JSONB`,
  `
    CREATE TABLE IF NOT EXISTS test_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      score NUMERIC(8,2) NOT NULL DEFAULT 0,
      total_marks NUMERIC(8,2) NOT NULL DEFAULT 0,
      correct_count INT NOT NULL DEFAULT 0,
      incorrect_count INT NOT NULL DEFAULT 0,
      unattempted_count INT NOT NULL DEFAULT 0,
      percentile NUMERIC(6,2),
      all_india_rank INT,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      weak_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      strong_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      solutions JSONB NOT NULL DEFAULT '[]'::jsonb,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS daily_quizzes (
      id TEXT PRIMARY KEY,
      quiz_date DATE NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL DEFAULT 'Daily Quiz',
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS daily_quiz_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      daily_quiz_id TEXT NOT NULL REFERENCES daily_quizzes(id) ON DELETE CASCADE,
      score INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, daily_quiz_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      access_type VARCHAR(40) NOT NULL DEFAULT 'course',
      source VARCHAR(40) NOT NULL DEFAULT 'payment',
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      view_count INT NOT NULL DEFAULT 0,
      UNIQUE (user_id, course_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS watch_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      progress_seconds INT NOT NULL DEFAULT 0,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      lesson_stage VARCHAR(20),
      exam_submitted BOOLEAN NOT NULL DEFAULT FALSE,
      exam_selected_option INT,
      explanation_seconds INT NOT NULL DEFAULT 0,
      video_watch_count INT NOT NULL DEFAULT 0,
      explanation_watch_count INT NOT NULL DEFAULT 0,
      last_session_id TEXT,
      last_device JSONB,
      last_watched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, course_id, lesson_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS video_access_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      access_type VARCHAR(40) NOT NULL DEFAULT 'replay',
      expires_at TIMESTAMPTZ NOT NULL,
      max_views INT NOT NULL DEFAULT 2,
      used_views INT NOT NULL DEFAULT 0,
      active_session_id TEXT,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, course_id, lesson_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS live_classes (
      id TEXT PRIMARY KEY,
      linkage_type VARCHAR(40) NOT NULL DEFAULT 'standalone',
      course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
      module_id TEXT,
      module_title VARCHAR(160),
      chapter_id TEXT,
      chapter_title VARCHAR(160),
      mock_test_id TEXT REFERENCES tests(id) ON DELETE SET NULL,
      mock_test_title VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      instructor_name VARCHAR(120),
      scheduled_start_at TIMESTAMPTZ NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 60,
      provider VARCHAR(40) NOT NULL DEFAULT 'Zoom',
      mode VARCHAR(20) NOT NULL DEFAULT 'live',
      status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
      live_playback_url TEXT,
      live_playback_type VARCHAR(20) NOT NULL DEFAULT 'hls',
      embed_url TEXT,
      room_url TEXT,
      recording_url TEXT,
      replay_course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
      replay_lesson_id TEXT,
      chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      doubt_solving BOOLEAN NOT NULL DEFAULT TRUE,
      replay_available BOOLEAN NOT NULL DEFAULT TRUE,
      attendee_count INT NOT NULL DEFAULT 0,
      max_attendees INT NOT NULL DEFAULT 2500,
      requires_enrollment BOOLEAN NOT NULL DEFAULT TRUE,
      recording_storage_provider VARCHAR(20),
      recording_storage_path TEXT,
      recording_published_at TIMESTAMPTZ,
      recording_expires_at TIMESTAMPTZ,
      recording_duration_minutes INT,
      poster_url TEXT,
      class_description TEXT,
      teacher_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      session_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      resource_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      active_poll JSONB,
      topic_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS linkage_type VARCHAR(40) NOT NULL DEFAULT \'standalone\'',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT \'scheduled\'',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS live_playback_url TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS live_playback_type VARCHAR(20) NOT NULL DEFAULT \'hls\'',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS embed_url TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS replay_course_id TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS replay_lesson_id TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS max_attendees INT NOT NULL DEFAULT 2500',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS requires_enrollment BOOLEAN NOT NULL DEFAULT TRUE',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS module_id TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS module_title VARCHAR(160)',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS chapter_id TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS chapter_title VARCHAR(160)',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS mock_test_id TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS mock_test_title VARCHAR(255)',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS recording_storage_provider VARCHAR(20)',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS recording_storage_path TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS recording_published_at TIMESTAMPTZ',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS recording_expires_at TIMESTAMPTZ',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS recording_duration_minutes INT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS poster_url TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS class_description TEXT',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS teacher_profile JSONB NOT NULL DEFAULT \'{}\'::jsonb',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS session_notes JSONB NOT NULL DEFAULT \'[]\'::jsonb',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS resource_items JSONB NOT NULL DEFAULT \'[]\'::jsonb',
  'ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS active_poll JSONB',
  'ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0',
  `
    ALTER TABLE video_access_grants
    ADD COLUMN IF NOT EXISTS access_type VARCHAR(40) NOT NULL DEFAULT 'replay'
  `,
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS max_views INT NOT NULL DEFAULT 2',
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS used_views INT NOT NULL DEFAULT 0',
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS active_session_id TEXT',
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ',
  'ALTER TABLE video_access_grants ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS lesson_stage VARCHAR(20)',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS exam_submitted BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS exam_selected_option INT',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS explanation_seconds INT NOT NULL DEFAULT 0',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS video_watch_count INT NOT NULL DEFAULT 0',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS explanation_watch_count INT NOT NULL DEFAULT 0',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS last_session_id TEXT',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS last_device JSONB',
  'ALTER TABLE watch_history ADD COLUMN IF NOT EXISTS last_watched_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  `
    WITH ranked_watch_history AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, course_id, lesson_id
          ORDER BY completed DESC, progress_seconds DESC, updated_at DESC, id DESC
        ) AS row_rank
      FROM watch_history
    )
    DELETE FROM watch_history
    WHERE id IN (
      SELECT id FROM ranked_watch_history WHERE row_rank > 1
    )
  `,
  'ALTER TABLE watch_history DROP CONSTRAINT IF EXISTS watch_history_user_id_lesson_id_key',
  'ALTER TABLE watch_history DROP CONSTRAINT IF EXISTS watch_history_user_id_course_id_lesson_id_key',
  'ALTER TABLE watch_history ADD CONSTRAINT watch_history_user_id_course_id_lesson_id_key UNIQUE (user_id, course_id, lesson_id)',
  `
    CREATE TABLE IF NOT EXISTS live_replay_access_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      live_class_id TEXT NOT NULL REFERENCES live_classes(id) ON DELETE CASCADE,
      access_type VARCHAR(40) NOT NULL DEFAULT 'live-replay',
      expires_at TIMESTAMPTZ NOT NULL,
      max_views INT NOT NULL DEFAULT 2,
      used_views INT NOT NULL DEFAULT 0,
      active_session_id TEXT,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, live_class_id)
    )
  `,
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS access_type VARCHAR(40) NOT NULL DEFAULT \'live-replay\'',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS max_views INT NOT NULL DEFAULT 2',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS used_views INT NOT NULL DEFAULT 0',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS active_session_id TEXT',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ',
  'ALTER TABLE live_replay_access_grants ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ',
  `
    CREATE TABLE IF NOT EXISTS live_chat_messages (
      id TEXT PRIMARY KEY,
      live_class_id TEXT NOT NULL REFERENCES live_classes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name VARCHAR(120) NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'chat',
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
      billing_cycle VARCHAR(40) NOT NULL DEFAULT 'monthly',
      access_type VARCHAR(40) NOT NULL DEFAULT 'subscription',
      feature_list JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      source VARCHAR(40) NOT NULL DEFAULT 'payment',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      notification_type VARCHAR(40) NOT NULL DEFAULT 'general',
      entity_id TEXT,
      action_url TEXT,
      action_label VARCHAR(80),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id TEXT',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_label VARCHAR(80)',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT \'{}\'::jsonb',
  `
    CREATE TABLE IF NOT EXISTS lesson_doubt_threads (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      student_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_name VARCHAR(160) NOT NULL,
      student_email VARCHAR(160),
      course_title VARCHAR(255) NOT NULL,
      module_title VARCHAR(160),
      chapter_title VARCHAR(160),
      lesson_title VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      last_message_preview TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (course_id, lesson_id, student_user_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS lesson_doubt_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES lesson_doubt_threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_role VARCHAR(20) NOT NULL DEFAULT 'student',
      user_name VARCHAR(160) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_email VARCHAR(160) NOT NULL,
      reward_points INT NOT NULL DEFAULT 25,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      provider VARCHAR(40) NOT NULL DEFAULT 'internal',
      provider_order_id TEXT,
      provider_payment_id TEXT,
      provider_signature TEXT,
      course_id TEXT,
      receipt VARCHAR(255),
      item VARCHAR(255) NOT NULL DEFAULT 'Course Purchase',
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 1,
      retryable BOOLEAN NOT NULL DEFAULT TRUE,
      last_error TEXT,
      payment_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(40) NOT NULL DEFAULT 'internal'`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_order_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payment_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_signature TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS course_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt VARCHAR(255)`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_meta JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
  `
    CREATE TABLE IF NOT EXISTS payment_webhooks (
      id TEXT PRIMARY KEY,
      event VARCHAR(80) NOT NULL,
      payment_id TEXT,
      status VARCHAR(30) NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS admin_uploads (
      id TEXT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      course_id TEXT,
      question_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_user_status_last_seen ON user_sessions(user_id, status, last_seen_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_device_activity_user_id ON device_activity(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_device_activity_user_created ON device_activity(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_user_id ON test_attempts(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_user_completed ON test_attempts(user_id, completed_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_daily_quiz_attempts_user_id ON daily_quiz_attempts(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_daily_quiz_attempts_quiz_submitted ON daily_quiz_attempts(daily_quiz_id, submitted_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_course ON watch_history(user_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_lesson ON watch_history(user_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_course_lesson ON watch_history(user_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_threads_lesson ON lesson_doubt_threads(course_id, lesson_id, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_threads_student ON lesson_doubt_threads(student_user_id, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_messages_thread_created ON lesson_doubt_messages(thread_id, created_at ASC)',
  'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments(user_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_course_user ON enrollments(course_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_live_chat_messages_class_created ON live_chat_messages(live_class_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_live_classes_status_start ON live_classes(status, scheduled_start_at)',
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_video_access_grants_user_lesson ON video_access_grants(user_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_live_replay_access_grants_user_live ON live_replay_access_grants(user_id, live_class_id)',
];

const isSslDisabledTarget = (connectionString) =>
  connectionString.includes('localhost')
  || connectionString.includes('127.0.0.1')
  || connectionString.includes('@postgres:')
  || connectionString.includes('//postgres:');

const getPool = () => {
  if (!appConfig.postgresUrl) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: appConfig.postgresUrl,
      max: Math.max(1, Number(appConfig.postgresPoolMax || 20)),
      idleTimeoutMillis: Math.max(1_000, Number(appConfig.postgresIdleTimeoutMillis || 30_000)),
      connectionTimeoutMillis: Math.max(1_000, Number(appConfig.postgresConnectionTimeoutMillis || 10_000)),
      statement_timeout: Math.max(1_000, Number(appConfig.postgresStatementTimeoutMillis || 15_000)),
      query_timeout: Math.max(1_000, Number(appConfig.postgresStatementTimeoutMillis || 15_000)),
      ssl: isSslDisabledTarget(appConfig.postgresUrl)
        ? false
        : { rejectUnauthorized: false },
    });
  }

  return pool;
};

const isPostgresConfigured = () => Boolean(appConfig.postgresUrl);

const isPostgresReady = () => postgresReady;

const initializePostgres = async () => {
  const currentPool = getPool();
  if (!currentPool) {
    postgresReady = false;
    return {
      enabled: false,
      connected: false,
      mode: 'memory',
      reason: 'POSTGRES_URL not configured',
    };
  }

  if (postgresReady) {
    return {
      enabled: true,
      connected: true,
      mode: 'postgres',
    };
  }

  if (!postgresInitPromise) {
    postgresInitPromise = (async () => {
      let client;

      try {
        client = await currentPool.connect();
        for (const statement of schemaStatements) {
          await client.query(statement);
        }
        postgresReady = true;
        return {
          enabled: true,
          connected: true,
          mode: 'postgres',
        };
      } catch (error) {
        postgresReady = false;
        return {
          enabled: true,
          connected: false,
          mode: 'memory',
          reason: error.message,
        };
      } finally {
        client?.release();
      }
    })();
  }

  try {
    return await postgresInitPromise;
  } finally {
    postgresInitPromise = null;
  }
};

const queryPostgres = async (text, params = [], client = null) => {
  const executor = client || getPool();
  if (!executor) {
    throw new Error('Postgres is not configured');
  }

  if (!postgresReady) {
    await initializePostgres();
  }

  return executor.query(text, params);
};

const runInTransaction = async (handler) => {
  const currentPool = getPool();
  if (!currentPool) {
    throw new Error('Postgres is not configured');
  }

  if (!postgresReady) {
    const initState = await initializePostgres();
    if (!initState.connected) {
      throw new Error(initState.reason || 'Postgres initialization failed');
    }
  }

  const client = await currentPool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const checkPostgresHealth = async () => {
  const currentPool = getPool();
  if (!currentPool) {
    return {
      enabled: false,
      status: 'disabled',
      detail: 'POSTGRES_URL not configured',
    };
  }

  try {
    const initState = await initializePostgres();
    if (!initState.connected) {
      return {
        enabled: true,
        status: 'down',
        detail: initState.reason || 'schema initialization failed',
      };
    }

    const result = await currentPool.query('select current_database() as database, now() as now');
    return {
      enabled: true,
      status: 'up',
      detail: result.rows[0]?.database || 'connected',
      pool: {
        total: currentPool.totalCount,
        idle: currentPool.idleCount,
        waiting: currentPool.waitingCount,
      },
    };
  } catch (error) {
    postgresReady = false;
    return {
      enabled: true,
      status: 'down',
      detail: error.message,
    };
  }
};

module.exports = {
  getPool,
  isPostgresConfigured,
  isPostgresReady,
  initializePostgres,
  queryPostgres,
  runInTransaction,
  checkPostgresHealth,
};
