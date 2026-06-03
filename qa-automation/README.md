# QA Automation + UX Analysis Loop

This workspace adds a practical Android automation and UX review system around the current EduMaster app.

## What it does

- uses `Appium + WebdriverIO` against Android Chrome
- navigates core flows: login, dashboard, courses, mock tests, results, plans/profile area
- captures screenshots and page source at each step
- stores artifacts in structured timestamped folders
- detects likely failures:
  - missing required UI elements
  - slow loads
  - browser/app crashes
  - layout overflow risk
  - visible error text
- runs UX analysis:
  - heuristic checks locally
  - optional vision-model analysis if `OPENAI_API_KEY` is configured
- generates:
  - JSON summary
  - markdown UX findings
  - Flutter reference UI code for an improved dashboard shell

## Artifact structure

Each run writes to:

`qa-automation/artifacts/<timestamp>/`

- `screenshots/`
- `sources/`
- `logs/`
- `analysis/`
- `generated_flutter/`

## Prerequisites

1. Start this app locally:
   `npm run dev`
2. Start Appium server:
   `appium`
3. Start Android emulator or connect a device with Chrome installed.
4. In this folder install dependencies:
   `npm install`

## Run

`npm run android:web`

Or continuous audit loop:

`npm run loop`

Course video load validation:

`npm run load:course-video`

Production-scale course video QA matrix + ladder:

`npm run qa:course-video:matrix`

Full browser matrix plus `250 -> 750 -> 1000` ladder:

`npm run qa:course-video:production`

Continuous regression detection and playback health monitoring:

`npm run monitor:course-video`

Continuous light-mode profile:

`npm run monitor:course-video:light`

Continuous full-mode profile:

`npm run monitor:course-video:full`

Recommended replayable flow after backend deploy:

1. Prepare users once without running playback:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS=750 COURSE_LOAD_SETUP_CONCURRENCY=3 COURSE_LOAD_PREPARE_ONLY=true npm run load:course-video`
2. Reuse the generated `prepared-users.json` for playback-only scaling:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS=250 COURSE_LOAD_ACTIVE_CONCURRENCY=250 COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json npm run load:course-video`
3. Repeat with:
   - `COURSE_LOAD_USERS=500 COURSE_LOAD_ACTIVE_CONCURRENCY=500`
   - `COURSE_LOAD_USERS=750 COURSE_LOAD_ACTIVE_CONCURRENCY=750`
   - `COURSE_LOAD_USERS=1000 COURSE_LOAD_ACTIVE_CONCURRENCY=1000`

One-command recorded-video API ladder helper from the repo root:

`QA_BASE_URL=https://app.178.105.48.179.nip.io ./scripts/run-course-video-ladder.sh`

If you already have a prepared user manifest:

`QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json ./scripts/run-course-video-ladder.sh`

Defaults:

- `COURSE_VIDEO_LADDER_STAGES=250,500,750,1000`
- `COURSE_LOAD_REPORT_PREFIX_BASE=course-video-scale`

Real-browser recorded-video ladder helper from the repo root:

`QA_BASE_URL=https://app.178.105.48.179.nip.io ./scripts/run-recorded-browser-ladder.sh`

Defaults:

- `QA_VIDEO_BROWSER_STAGES=50,100,250`
- prepares a fresh QA browser manifest automatically when one is not supplied

Mixed app-traffic ladder helper from the repo root:

`QA_BASE_URL=https://app.178.105.48.179.nip.io ./scripts/run-platform-scale-ladder.sh`

Defaults:

- `PLATFORM_LADDER_STAGES=2000,5000,10000,15000`
- `PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS=1`
- `PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT=0`
- `PLATFORM_LOAD_ENABLE_LIVE=0`
- `PLATFORM_LOAD_ENABLE_ENROLL=0`
- `PLATFORM_LOAD_ENABLE_PROFILE_UPDATE=0`

Named mixed-traffic cohort model for the `5k` certification target:

- `PLATFORM_LOAD_TRAFFIC_MODEL=5k-mixed`
- `PLATFORM_LOAD_BROWSE_READ_PERCENT=70`
- `PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT=15`
- `PLATFORM_LOAD_AUTH_SESSION_PERCENT=10`
- `PLATFORM_LOAD_LIGHT_WRITE_PERCENT=5`

One-command `5k` mixed readiness flow from the repo root:

```bash
QA_BASE_URL=https://app.example.com \
QA_COURSE_TEXT='Course name' \
QA_LESSON_TEXT='Lesson name' \
QA_WATCH_LIMIT_COURSE_ID=course_id \
QA_WATCH_LIMIT_LESSON_ID=lesson_id \
./scripts/run-5k-mixed-readiness.sh
```

This wrapper runs:

- desktop/mobile recorded-video regressions
- recorded-browser `50 -> 100 -> 250`
- recorded-video synthetic `250 -> 500 -> 750 -> 1000`
- mixed app `2000 -> 5000`

Findings-first `2k` mixed validation flow from the repo root:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.46.225.218.53.nip.io \
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
./scripts/run-2k-findings-first-validation.sh
```

This runner:

- captures baseline host snapshots for staging and prod
- logs stray restarting or unhealthy containers before load
- runs targeted recorded-video correctness checks on staging
- runs recorded-browser stages `50 -> 100 -> 250`
- runs recorded-video synthetic stages `250 -> 500 -> 750 -> 1000`
- runs mixed app stages `500 -> 1000 -> 1500 -> 2000`
- stops on the first failing stage
- classifies failures into app/API, media path, DB, Redis, browser-only, or staging-host-exhaustion buckets
- runs production smoke only after staging is green

The course video load runner supports:

- `COURSE_LOAD_PREPARE_ONLY=true`:
  prepares users and writes a reusable manifest without starting video playback
- `COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json`:
  reuses an existing user manifest instead of creating accounts again
- `COURSE_LOAD_REFRESH_EXISTING_USER_TOKENS=false`:
  skips token refresh if the manifest tokens are still valid

Sustained-watch mode for true playback soak validation:

```bash
QA_BASE_URL=https://app.178.105.48.179.nip.io \
COURSE_LOAD_USERS=1000 \
COURSE_LOAD_ACTIVE_CONCURRENCY=1000 \
COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json \
COURSE_LOAD_REFRESH_EXISTING_USER_TOKENS=false \
COURSE_LOAD_WATCH_MODE=sustained \
COURSE_LOAD_WATCH_DURATION_SECONDS=3600 \
COURSE_LOAD_WATCH_HEARTBEAT_SECONDS=30 \
COURSE_LOAD_WATCH_PROGRESS_INTERVAL_SECONDS=120 \
COURSE_LOAD_WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS=60 \
COURSE_LOAD_WATCH_SEGMENT_WINDOW_SIZE=2 \
npm run load:course-video
```

Mixed-course sustained traffic:

```bash
QA_BASE_URL=https://app.178.105.48.179.nip.io \
COURSE_LOAD_USERS=1000 \
COURSE_LOAD_ACTIVE_CONCURRENCY=1000 \
COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json \
COURSE_LOAD_REFRESH_EXISTING_USER_TOKENS=false \
COURSE_LOAD_WATCH_MODE=sustained \
COURSE_LOAD_WATCH_DURATION_SECONDS=3600 \
COURSE_LOAD_HOT_COURSE_PERCENT=92 \
COURSE_LOAD_MIXED_ASSIGNMENTS_JSON='[
  {"courseId":"course_other_1","lessonId":"lesson_other_1","weight":4,"label":"mixed-ssc"},
  {"courseId":"course_other_2","lessonId":"lesson_other_2","weight":4,"label":"mixed-banking"}
]' \
npm run load:course-video
```

Controlled failure injection during soak:

```bash
COURSE_LOAD_FAILURE_INJECTIONS_JSON='[
  {"name":"backend-restart","command":"ssh root@host \"docker compose restart app app-2\"","delaySeconds":900},
  {"name":"manifest-restart","command":"ssh root@host \"docker compose restart manifest-app manifest-app-2\"","delaySeconds":1800}
]'
```

Optional infrastructure telemetry:

```bash
COURSE_LOAD_RESOURCE_COMMAND='docker stats --no-stream'
COURSE_LOAD_RESOURCE_INTERVAL_SECONDS=60
```

Current honest capacity verdict and the future `10k-15k` mixed-traffic upgrade path live in:

- `docs/capacity-verdict-and-10k-mixed-traffic-plan.md`
- `docs/5k-mixed-traffic-readiness-plan.md`
- `docs/cheapest-practical-5k-infrastructure-plan.md`

The production course video QA runner extends the existing framework instead of replacing it. It adds:

- a full categorized test-case matrix for auth, dashboard, navigation, playback, HLS, resilience, UI, performance, and security
- Playwright-driven real student playback validation using the existing selectors and current course-video load runner
- per-case evidence under `qa-automation/reports/course-video-production-qa-<run-id>/`
- HTML, JSON, and CSV summary output
- stepped production ladder execution at `250`, `750`, and `1000` users

The continuous monitor extends that same framework into a repeatable regression detection system. Each monitor run now:

- normalizes existing load and browser outputs into `qa-automation/runs/<run-id>/`
- computes baseline comparison, regression severity, and playback health score
- updates historical metrics per environment under `qa-automation/monitoring-data/<env>/`
- emits alert payloads when performance drifts beyond thresholds
- generates:
  - `summary.json`
  - `baseline-comparison.json`
  - `regression-report.json`
  - `trend-data.json`
  - `run-dashboard.html`
  - `regression-summary.html`
  - `trend-dashboard.html`
  - `health-score.json`
  - `repro-case/`

Typical monitoring flow:

1. Approve a baseline from a known-good production run:
   `QA_MONITOR_ENV=prod QA_MONITOR_APPROVE_BASELINE=true npm run monitor:course-video`
2. Compare new runs against the approved baseline:
   `QA_MONITOR_ENV=prod npm run monitor:course-video`
3. Optional scheduled profiles:
   - `QA_MONITOR_MODE=continuous-light`
   - `QA_MONITOR_MODE=continuous-full`

If you want the monitor to trigger a QA command before analysis:

`QA_MONITOR_EXECUTE=true QA_MONITOR_MODE=continuous-light npm run monitor:course-video`

Optional explicit report inputs:

`QA_MONITOR_LOAD_REPORTS=/abs/path/to/load-a,/abs/path/to/load-b QA_MONITOR_BROWSER_REPORT=/abs/path/to/browser-root npm run monitor:course-video`

Typical production flow:

1. Matrix only:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io QA_LOGIN_EMAIL=student@... QA_LOGIN_PASSWORD=... npm run qa:course-video:matrix`
2. Prepare or reuse load users:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json npm run qa:course-video:production`
3. Optional resilience hooks:
   - `PLAYBACK_QA_BACKEND_RESTART_COMMAND="ssh root@host 'docker compose restart app app-2'"`
   - `PLAYBACK_QA_MANIFEST_RESTART_COMMAND="ssh root@host 'docker compose restart manifest-app manifest-app-2'"`
   - `PLAYBACK_QA_NGINX_RESTART_COMMAND="ssh root@host 'docker compose restart recorded-hls-cache'"`

Playwright prerequisite:

`npx playwright install chromium`

## Environment

Optional environment variables:

- `QA_BASE_URL=http://10.0.2.2:3000`
- `QA_APPIUM_HOST=127.0.0.1`
- `QA_APPIUM_PORT=4723`
- `QA_ANDROID_DEVICE=Android Emulator`
- `QA_BROWSER_NAME=Chrome`
- `QA_LOGIN_EMAIL=student@edumaster.local`
- `QA_LOGIN_PASSWORD=Student@123`
- `QA_SLOW_MS=6000`
- `COURSE_LOAD_USERS=250`
- `COURSE_LOAD_SETUP_CONCURRENCY=3`
- `COURSE_LOAD_ACTIVE_CONCURRENCY=250`
- `COURSE_LOAD_TIMEOUT_MS=30000`
- `COURSE_LOAD_PREPARE_ONLY=true|false`
- `COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json`
- `COURSE_LOAD_REFRESH_EXISTING_USER_TOKENS=true|false`
- `COURSE_LOAD_WATCH_MODE=sustained|''`
- `COURSE_LOAD_WATCH_DURATION_SECONDS=3600`
- `COURSE_LOAD_WATCH_HEARTBEAT_SECONDS=30`
- `COURSE_LOAD_WATCH_PROGRESS_INTERVAL_SECONDS=120`
- `COURSE_LOAD_WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS=60`
- `COURSE_LOAD_WATCH_SEGMENT_WINDOW_SIZE=2`
- `COURSE_LOAD_WATCH_QUALITY_SWITCH_INTERVAL_SECONDS=300`
- `COURSE_LOAD_WATCH_AUTH_REFRESH_INTERVAL_SECONDS=900`
- `COURSE_LOAD_WATCH_ALLOW_REAL_SLEEP=true|false`
- `COURSE_LOAD_HOT_COURSE_PERCENT=95`
- `COURSE_LOAD_MIXED_ASSIGNMENTS_JSON='[...]'`
- `COURSE_LOAD_RESOURCE_COMMAND='docker stats --no-stream'`
- `COURSE_LOAD_RESOURCE_INTERVAL_SECONDS=60`
- `COURSE_LOAD_FAILURE_INJECTIONS_JSON='[...]'`
- `PLAYBACK_QA_SKIP_LOAD=true|false`
- `QA_MONITOR_ENV=dev|staging|prod`
- `QA_MONITOR_MODE=continuous-light|continuous-full|manual-trigger`
- `QA_MONITOR_EXECUTE=true|false`
- `QA_MONITOR_APPROVE_BASELINE=true|false`
- `QA_MONITOR_AUTO_COMPARE=true|false`
- `QA_MONITOR_TAGS=nightly,prod`
- `QA_MONITOR_LOAD_REPORTS=/abs/path/a,/abs/path/b`
- `QA_MONITOR_BROWSER_REPORT=/abs/path/to/browser-report`
- `QA_MONITOR_COMMAND="npm --prefix qa-automation run qa:course-video:production"`
- `QA_MONITOR_WEBHOOK_URL=https://hooks.example.com/...`
- `PLAYBACK_QA_SKIP_LOAD=true|false`
- `PLAYBACK_QA_HEADED=true|false`
- `PLAYBACK_QA_BROWSER_WORKERS=4`
- `PLAYBACK_QA_CASE_RETRIES=1`
- `PLAYBACK_QA_SENTINEL_USERS=12`
- `PLAYBACK_QA_SENTINEL_CONCURRENCY=4`
- `PLAYBACK_QA_SENTINEL_CHECKPOINT_SECONDS=300,900,1800,2700,3600`
- `PLAYBACK_QA_SENTINEL_USE_PREPARED_USERS=true|false`
- `PLAYBACK_QA_WATCH_SHORT_MS=20000`
- `PLAYBACK_QA_WATCH_MEDIUM_MS=45000`
- `PLAYBACK_QA_WATCH_LONG_MS=90000`
- `PLAYBACK_QA_WATCH_SOAK_MS=180000`
- `PLAYBACK_QA_RESOURCE_COMMAND="docker stats --no-stream"`
- `PLAYBACK_QA_BACKEND_RESTART_COMMAND="..."`
- `PLAYBACK_QA_MANIFEST_RESTART_COMMAND="..."`
- `PLAYBACK_QA_NGINX_RESTART_COMMAND="..."`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-4.1-mini`
- `OPENAI_BASE_URL=https://api.openai.com/v1`

## Notes

- This repo is a `React web app`, not a Flutter app. The generated Flutter code is a reference output based on the QA/UX analysis, not a live app migration.
- The selectors use `data-testid` hooks added to the web UI so Appium is less fragile.
