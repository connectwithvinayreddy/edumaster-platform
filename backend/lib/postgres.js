const { Pool } = require('pg');
const { appConfig } = require('./config.js');

let pool = null;
let postgresReady = false;
let postgresInitPromise = null;
const POSTGRES_SCHEMA_INIT_LOCK_ID = 612348901;

const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      mobile_number VARCHAR(20),
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'student',
      account_status VARCHAR(20) NOT NULL DEFAULT 'active',
      status_note TEXT,
      device JSONB,
      active_session_id TEXT,
      streak_days INT NOT NULL DEFAULT 0,
      reward_points INT NOT NULL DEFAULT 0,
      badges JSONB NOT NULL DEFAULT '[]'::jsonb,
      referral_code VARCHAR(32),
      last_login_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      blocked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(20)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS status_note TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`,
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
      editorials JSONB NOT NULL DEFAULT '[]'::jsonb,
      modules JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE courses ADD COLUMN IF NOT EXISTS offer_percentage NUMERIC(5,2) NOT NULL DEFAULT 0',
  "ALTER TABLE courses ADD COLUMN IF NOT EXISTS editorials JSONB NOT NULL DEFAULT '[]'::jsonb",
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
      rank_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      rank_computed_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, test_id)
    )
  `,
  'ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS rank_status VARCHAR(20) NOT NULL DEFAULT \'pending\'',
  'ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS rank_computed_at TIMESTAMPTZ',
  `
    UPDATE test_attempts
    SET rank_status = CASE
      WHEN all_india_rank IS NULL OR percentile IS NULL THEN 'pending'
      ELSE 'ready'
    END
    WHERE rank_status IS NULL OR rank_status NOT IN ('pending', 'ready', 'failed')
  `,
  `
    WITH ranked_test_attempts AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, test_id
          ORDER BY completed_at DESC, started_at DESC, id DESC
        ) AS row_rank
      FROM test_attempts
    )
    DELETE FROM test_attempts
    WHERE id IN (
      SELECT id FROM ranked_test_attempts WHERE row_rank > 1
    )
  `,
  'ALTER TABLE test_attempts DROP CONSTRAINT IF EXISTS test_attempts_user_id_test_id_key',
  'ALTER TABLE test_attempts ADD CONSTRAINT test_attempts_user_id_test_id_key UNIQUE (user_id, test_id)',
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
      access_status VARCHAR(20) NOT NULL DEFAULT 'enabled',
      admin_note TEXT,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      view_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, course_id)
    )
  `,
  `ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS access_status VARCHAR(20) NOT NULL DEFAULT 'enabled'`,
  `ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS admin_note TEXT`,
  `ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
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
    CREATE TABLE IF NOT EXISTS video_watch_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL,
      lesson_id TEXT,
      video_id TEXT NOT NULL,
      video_type VARCHAR(40) NOT NULL DEFAULT 'course',
      video_duration_seconds INT NOT NULL DEFAULT 0,
      allowed_full_watches INT NOT NULL DEFAULT 1,
      completed_full_watches INT NOT NULL DEFAULT 0,
      full_watch_threshold_percentage NUMERIC(5,2) NOT NULL DEFAULT 95,
      watched_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_cycle_unique_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      total_unique_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      repeat_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      revision_buffer_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      revision_buffer_used_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      stable_end_window_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      completion_proof_satisfied_at TIMESTAMPTZ,
      last_position_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,
      playback_session_id TEXT,
      active_session_status VARCHAR(30) NOT NULL DEFAULT 'idle',
      device_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      last_heartbeat_at TIMESTAMPTZ,
      is_locked BOOLEAN NOT NULL DEFAULT FALSE,
      locked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, course_id, video_id, video_type)
    )
  `,
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS lesson_id TEXT',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS video_type VARCHAR(40) NOT NULL DEFAULT \'course\'',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS video_duration_seconds INT NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS allowed_full_watches INT NOT NULL DEFAULT 1',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS completed_full_watches INT NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS full_watch_threshold_percentage NUMERIC(5,2) NOT NULL DEFAULT 95',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS watched_segments JSONB NOT NULL DEFAULT \'[]\'::jsonb',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS current_cycle_unique_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS total_unique_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS repeat_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS revision_buffer_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS revision_buffer_used_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS stable_end_window_watched_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS completion_proof_satisfied_at TIMESTAMPTZ',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS last_position_seconds NUMERIC(12,3) NOT NULL DEFAULT 0',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS playback_session_id TEXT',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS active_session_status VARCHAR(30) NOT NULL DEFAULT \'idle\'',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS device_id TEXT',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS ip_address TEXT',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS user_agent TEXT',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  'ALTER TABLE video_watch_states ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  'ALTER TABLE video_watch_states ALTER COLUMN full_watch_threshold_percentage SET DEFAULT 95',
  'ALTER TABLE video_watch_states DROP CONSTRAINT IF EXISTS video_watch_states_user_id_course_id_video_id_key',
  'ALTER TABLE video_watch_states DROP CONSTRAINT IF EXISTS video_watch_states_user_id_course_id_video_id_video_type_key',
  'ALTER TABLE video_watch_states ADD CONSTRAINT video_watch_states_user_id_course_id_video_id_video_type_key UNIQUE (user_id, course_id, video_id, video_type)',
  `
    CREATE TABLE IF NOT EXISTS course_content_access_rules (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      student_scope VARCHAR(20) NOT NULL DEFAULT 'all_students',
      student_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      content_scope VARCHAR(20) NOT NULL DEFAULT 'course',
      module_id TEXT,
      chapter_id TEXT,
      lesson_id TEXT,
      access VARCHAR(10) NOT NULL DEFAULT 'block',
      admin_note TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS student_scope VARCHAR(20) NOT NULL DEFAULT \'all_students\'',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS student_id TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS content_scope VARCHAR(20) NOT NULL DEFAULT \'course\'',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS module_id TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS chapter_id TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS lesson_id TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS access VARCHAR(10) NOT NULL DEFAULT \'block\'',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS admin_note TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS created_by TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS updated_by TEXT',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  'ALTER TABLE course_content_access_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  `
    CREATE TABLE IF NOT EXISTS student_lesson_watch_overrides (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL,
      chapter_id TEXT,
      lesson_id TEXT NOT NULL,
      allowed_full_watches INT NOT NULL DEFAULT 2,
      watch_completion_percent INT,
      admin_note TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (course_id, student_id, lesson_id)
    )
  `,
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS module_id TEXT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS chapter_id TEXT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS allowed_full_watches INT NOT NULL DEFAULT 2',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS watch_completion_percent INT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS admin_note TEXT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS created_by TEXT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS updated_by TEXT',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  'ALTER TABLE student_lesson_watch_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
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
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id TEXT',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_label VARCHAR(80)',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT \'{}\'::jsonb',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ',
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
      attachment_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE lesson_doubt_messages ADD COLUMN IF NOT EXISTS attachment_meta JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `
    CREATE TABLE IF NOT EXISTS lesson_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      video_id TEXT,
      user_name VARCHAR(160) NOT NULL,
      user_email VARCHAR(160),
      course_title VARCHAR(255) NOT NULL,
      module_title VARCHAR(160),
      chapter_title VARCHAR(160),
      lesson_title VARCHAR(255) NOT NULL,
      issue_type VARCHAR(60) NOT NULL DEFAULT 'other',
      description TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      screenshot_url TEXT,
      attachment_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      admin_attachment_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      admin_note TEXT,
      admin_reply TEXT,
      source VARCHAR(40) NOT NULL DEFAULT 'video_player',
      page_url TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  `ALTER TABLE lesson_reports ADD COLUMN IF NOT EXISTS admin_attachment_meta JSONB NOT NULL DEFAULT '{}'::jsonb`,
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
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_type VARCHAR(80) NOT NULL,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
      transaction_id TEXT,
      old_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      new_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_created_desc ON user_sessions(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_device_activity_user_id ON device_activity(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_device_activity_user_created ON device_activity(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_device_activity_created_desc ON device_activity(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
  'CREATE INDEX IF NOT EXISTS idx_users_mobile_number ON users(mobile_number)',
  'CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_user_id ON test_attempts(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_test_id ON test_attempts(test_id)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_user_completed ON test_attempts(user_id, completed_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_test_attempts_test_rank_status ON test_attempts(test_id, rank_status, completed_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_daily_quiz_attempts_user_id ON daily_quiz_attempts(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_daily_quiz_attempts_quiz_submitted ON daily_quiz_attempts(daily_quiz_id, submitted_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments(user_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_user_expires_course ON enrollments(user_id, expires_at, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_course_expires ON enrollments(course_id, expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_course ON watch_history(user_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_lesson ON watch_history(user_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_user_course_lesson ON watch_history(user_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_course_lesson_updated ON watch_history(course_id, lesson_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_watch_history_updated_at ON watch_history(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_user_video ON video_watch_states(user_id, video_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_user_course_updated ON video_watch_states(user_id, course_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_user_course_video ON video_watch_states(user_id, course_id, video_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_lesson_id ON video_watch_states(lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_playback_session_id ON video_watch_states(playback_session_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_device_id ON video_watch_states(device_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_updated_at ON video_watch_states(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_video_watch_states_created_at ON video_watch_states(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_course_content_access_rules_course_student ON course_content_access_rules(course_id, student_scope, student_id)',
  'CREATE INDEX IF NOT EXISTS idx_course_content_access_rules_course_scope ON course_content_access_rules(course_id, content_scope, chapter_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_student_lesson_watch_overrides_student_course ON student_lesson_watch_overrides(student_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_student_lesson_watch_overrides_student_lesson ON student_lesson_watch_overrides(student_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_access_grants_user_course_lesson ON video_access_grants(user_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_video_access_grants_expires_at ON video_access_grants(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_video_access_grants_active_session ON video_access_grants(active_session_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_threads_lesson ON lesson_doubt_threads(course_id, lesson_id, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_threads_student ON lesson_doubt_threads(student_user_id, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_doubt_messages_thread_created ON lesson_doubt_messages(thread_id, created_at ASC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_reports_user_created ON lesson_reports(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_reports_course_lesson_created ON lesson_reports(course_id, lesson_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_lesson_reports_status_created ON lesson_reports(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id ON payments(provider_payment_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id ON payments(provider_order_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
  'CREATE INDEX IF NOT EXISTS idx_payments_course_id ON payments(course_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments(user_id, course_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_course_user ON enrollments(course_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_access_status ON enrollments(access_status)',
  'CREATE INDEX IF NOT EXISTS idx_enrollments_valid_until ON enrollments(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_live_chat_messages_class_created ON live_chat_messages(live_class_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_live_classes_status_start ON live_classes(status, scheduled_start_at)',
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_video_access_grants_user_lesson ON video_access_grants(user_id, course_id, lesson_id)',
  'CREATE INDEX IF NOT EXISTS idx_live_replay_access_grants_user_live ON live_replay_access_grants(user_id, live_class_id)',
  'CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_created ON admin_audit_logs(target_user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_created ON admin_audit_logs(admin_user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_transaction ON admin_audit_logs(transaction_id)',
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
        await client.query('SELECT pg_advisory_lock($1)', [POSTGRES_SCHEMA_INIT_LOCK_ID]);
        try {
          for (const statement of schemaStatements) {
            await client.query(statement);
          }
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [POSTGRES_SCHEMA_INIT_LOCK_ID]).catch(() => {});
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
