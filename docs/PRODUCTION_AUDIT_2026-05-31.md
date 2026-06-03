# Production Audit - 2026-05-31

## Executive Status

- Current status: improved, but **not yet certified production-ready for 10,000-15,000 concurrent students**
- Immediate Cloudflare Host Error incident: **root causes identified and mitigated**
- Confirmed production today:
  - `https://app.varonenglishapp.in/backend/api/health` returns `200`
  - `https://app.varonenglishapp.in/backend/api/ready` returns `200`
  - both API replicas are healthy after the latest restart

## Exact Root Causes Found

### 1. Video heartbeat crash in production

- Endpoint involved: `/backend/api/track`
- Failure mode:
  - protected playback heartbeat wrote `video_duration_seconds`
  - some lessons produced fractional durations like `1207.5`
  - PostgreSQL column `video_watch_states.video_duration_seconds` is `INT`
  - insert/update failed with `invalid input syntax for type integer: "1207.5"`
- Effect:
  - request handler threw
  - app replica became unstable
  - Caddy returned `502`
  - Cloudflare showed `Host Error / Bad Gateway`

### 2. Startup schema race between replicas

- File involved: `backend/lib/postgres.js`
- Failure mode:
  - both replicas bootstrap schema on startup
  - startup migration sequence drops/adds constraints
  - concurrent boots could race
  - one replica failed with:
    - `Persistent database unavailable: Postgres unavailable: relation "video_watch_states_user_id_course_id_video_id_video_type_key" already exists`
- Effect:
  - one app replica flapped during restart
  - Caddy sometimes lost available upstreams
  - intermittent `503 no upstreams available`

### 3. Reverse-proxy health checks were too expensive

- File involved: `infra/lowcost/Caddyfile`
- Failure mode:
  - Caddy active health check used `/api/health`
  - that endpoint checks Postgres and Redis
  - under DB slowness, proxy health checks marked app replicas down
- Effect:
  - healthy Node processes were sometimes removed from load balancing
  - this amplified intermittent origin failures

### 4. Overview aggregation is too heavy for large traffic

- File involved: `backend/lib/repositories.js`
- Problem:
  - platform snapshot cache default was only `3s`
  - cold rebuild loads users, courses, tests, enrollments, watch history, sessions, payments, and more in one transaction
- Effect:
  - overview traffic can spike DB load
  - contributes to query timeouts and degraded health behavior

## Fixes Applied

### Code fixes

- `backend/lib/video-watch-limits.js`
  - normalized duration seconds with `Math.ceil(...)` before persistence
- `backend/lib/postgres.js`
  - added PostgreSQL advisory lock around schema bootstrap to serialize replica startup migrations
- `backend/lib/config.js`
  - raised default `PLATFORM_DATA_CACHE_TTL_MS` from `3000` to `30000`
- `.env.production.varonenglishapp.template`
  - documented `PLATFORM_DATA_CACHE_TTL_MS=30000`

### Infrastructure / production fixes

- production `.env.production`
  - set `PLATFORM_DATA_CACHE_TTL_MS=30000`
- `infra/lowcost/Caddyfile`
  - added active upstream health checks
  - switched app active health probe from `/api/health` to `/api/live`
  - kept retry window enabled
- production containers rebuilt and restarted

## Validation Performed

### Local

- `npm test -- --runInBand`
  - passed
- `npm run build`
  - passed

### Production

- health and ready endpoints return `200`
- both API replicas reached healthy state after latest deployment
- repeated external checks to:
  - `/backend/api/live`
  - `/backend/api/health`
  - `/backend/api/ready`
  returned `200`
- post-fix proxy check:
  - no new `502/503/no upstreams available` entries were observed in the final 30-second verification window after the latest restart

## Current Risks Still Open

### 1. Large application bundle

- current production JS bundle is still about `3.6 MB` minified
- route-level code splitting is still needed

### 2. Heavy overview architecture

- `loadPlatformData()` still loads a broad snapshot for some flows
- this is not suitable for 10k-15k concurrency without deeper refactoring

### 3. Query timeout evidence exists in logs

- production logs showed `Query read timeout` and connection timeout errors during earlier load
- the immediate outage symptoms are reduced, but deeper query/path optimization is still required

### 4. No staged concurrency benchmark yet

- no 1k / 3k / 5k / 10k / 15k load certification has been completed in this round
- exact breaking point is still unknown

## Honest Capacity Assessment

- Current proven state:
  - app is healthier than before
  - immediate Host Error causes were real and were addressed
- Not yet proven:
  - stable operation at 10,000-15,000 concurrent mixed users
  - sustained spike handling for CBT, video heartbeat storms, chat, notifications, and mixed dashboard traffic

## Recommended Next Phase

### Backend / DB

- replace broad `loadPlatformData()` usage with targeted queries per endpoint
- add slow-query logging with endpoint correlation
- audit all hot queries with `EXPLAIN ANALYZE`
- add or confirm indexes for:
  - enrollments `(user_id, expires_at, course_id)`
  - watch history `(user_id, course_id, lesson_id, updated_at)`
  - video watch states `(user_id, course_id, video_id, video_type)`
  - notifications `(user_id, read, created_at)`
  - chat / doubts `(course_id, lesson_id, created_at)`

### Frontend

- split the app bundle by route
- lazy-load heavy tabs and admin/analytics flows
- add stronger request deduping around dashboard and course loads

### Infrastructure

- add dedicated monitoring for:
  - proxy 502/503 rate
  - Postgres query timeout count
  - container restart count
  - p95/p99 API latency
- consider pgbouncer or managed connection pooling if DB timeouts continue
- separate background/heavy work from the main API path

### Testing

- run staged load tests:
  - 1,000 concurrent
  - 3,000 concurrent
  - 5,000 concurrent
  - 10,000 concurrent
  - 15,000 stress ceiling
- run mixed-scenario automation for:
  - login
  - dashboard
  - course open
  - video player + heartbeat
  - test start/save/submit
  - notifications
  - doubts
  - issue reporting

## Final Status

- Immediate production incident: **mitigated**
- Exact Cloudflare Host Error causes: **identified**
- App fully ready for 10k-15k concurrent mixed usage: **not yet proven**
- Recommended label right now: **stabilized production, further load-hardening required**
