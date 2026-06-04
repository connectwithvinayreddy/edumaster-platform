# Capacity Verdict and `10-15k` Mixed-Traffic Upgrade Plan

## Current verdict

With the current architecture, current code, and current production evidence:

- the stack is **not ready for `3-5k` mixed real users** if recorded lesson playback is part of that traffic
- it is **far from `10-15k` mixed-traffic readiness**
- it is **not close to `10-15k` simultaneous active recorded-video viewers**

For future planning, the target should be:

- `10-15k` mixed traffic
- mostly browse, read, login, course navigation, and test listing
- `10-20%` concurrently active recorded-video users
- not `15k` simultaneous active video viewers

For the nearer-term certification path to `5000` mixed concurrent users, see:

- `docs/protected-hls-production-deploy-gate.md`
- `docs/5k-mixed-traffic-readiness-plan.md`
- `docs/cheapest-practical-5k-infrastructure-plan.md`

## Protected-HLS playback deploy gate

Any production release that changes protected-HLS or recorded-video playback behavior is now blocked until the real-browser `2,000` streaming-user gate passes.

That gate is stricter than the broader `5k` and `10-15k` capacity programs:

- it is playback-only
- it requires real browser users, not API-only or synthetic-only proof
- it requires the staged ladder:
  - `1 -> 3 -> 10 -> 25 -> 50 -> 100 -> 250 -> 500 -> 1000 -> 2000`
- it still requires explicit user confirmation after the report is green

See:

- `docs/protected-hls-production-deploy-gate.md`

## Repo evidence behind the verdict

### Real-browser recorded-video evidence

- `25` viewers are correctness-clean, but startup is already slow:
  - `qa-automation/artifacts/2026-06-02T03-18-27-599Z/analysis/course-video-browser-concurrency-summary.json`
  - `25/25` passed
  - startup `p95` about `14657ms`
- `50` viewers fail badly in startup:
  - `qa-automation/artifacts/2026-06-02T03-23-41-965Z/analysis/course-video-browser-concurrency-summary.json`
  - `5/50` passed, `45/50` failed
  - no manifest failures, no segment failures, no playback conflicts
  - failures cluster in `player_failure_after_shell`, plus some `runtime_crash` and `boot_failure`

### Synthetic recorded-video evidence

- active recorded-video load was already failing well below `1k`:
  - `reports/course-video-1000-2026-05-14T15-55-16-746Z/full-course-video-report.json`
  - `120/250` successful journeys
  - `course.video.mediaManifest` success rate `52.4%`
  - `course.video.mediaManifest` `p95` about `30005ms`
- sustained recorded-video traffic at `1000` is far from production-ready:
  - `reports/english-course-1000-r2-2026-05-18T06-27-06-922Z/full-course-video-report.json`
  - `331/1000` successful journeys
  - `course.player` success rate `59.4%`
  - `course.player` `p95` about `30002ms`

### Broader app-plane evidence

- the broader platform plane survives a large synthetic run, but without strong headroom:
  - `reports/platform-1000-2026-06-01T01-10-23-379Z/full-automation-test-report.json`
  - `975/975` successful journeys
  - `dashboard.overview` `p95` about `9702ms`
  - `dashboard.overview` `p99` about `14493ms`

## What the current single-host stack actually is

The current low-cost production shape still keeps too much on one host:

- `Caddy`
- `app`
- `app-2`
- `manifest-app`
- `manifest-app-2`
- `recorded-hls-cache`
- `Postgres`
- `Redis`
- workers and live services

See:

- `infra/lowcost/docker-compose.prod.yml`
- `infra/lowcost/Caddyfile`
- `infra/lowcost/recorded-hls-cache/nginx.conf`

That is a workable low-cost transition shape, but it is too much blast radius on one box for a real `3-5k+` mixed-traffic claim.

## Recorded-video path verdict

Recorded lessons are still the first scale blocker.

Current production uses a mixed recorded-video stack:

- Cloudflare at the edge
- S3-compatible object storage configured as Cloudflare R2
- `VIDEO_PROCESSING_PROVIDER=cloudflare-stream`
- some lessons through direct Cloudflare Stream HLS
- some lessons through the protected manifest, gateway, and cache path

Before any `3k+` claim, the recorded-video path should be standardized.

Recommended steady-state hot path for this repo's cost-sensitive direction:

- protected HLS in object storage
- manifest, gateway, and cache path in front
- Cloudflare at the edge
- main app only for auth, entitlement, bootstrap, and watch progress

Direct Cloudflare Stream playback can remain as a migration or legacy path, but it should not remain the permanent split delivery model for the same product surface.

## Target architecture for `10-15k` mixed traffic

Keep the current stack style, but split it into dedicated tiers.

### Edge

- Cloudflare stays for DNS, SSL, proxy, and CDN

### App/API tier

- `4` app replicas to start
- scale to `6` if the mixed-load evidence demands it

### Recorded-video media tier

- `2` recorded HLS cache and gateway instances
- `2` manifest-app instances
- standardized recorded-video hot path through gateway and cache

### Data tier

- dedicated Postgres host
- connection pooling in front of Postgres
- dedicated Redis host
- optional Postgres read replica once overview and catalog reads are isolated well enough to use it safely

### Worker tier

- move replay import, watch aggregation, and similar workers off the main app nodes

### Storage

- keep object storage as the long-term lesson media source
- do not keep the main app node in the steady-state byte-serving path

## Broader app-plane work required

Even outside recorded video, the app plane still needs headroom work:

- split heavy dashboard and overview reads into smaller fetches
- reduce broad polling and whole-tree refreshes
- isolate course and player runtime state from dashboard and catalog render churn
- keep frontend code-splitting in place and continue shrinking first-load cost
- keep Redis-backed session and playback state as the cross-replica truth
- track per-tier observability:
  - app bootstrap latency
  - player bootstrap latency
  - manifest latency
  - first-segment latency
  - DB pool saturation
  - Redis latency
  - cache hit ratio

## Scale gates to use from here

Use staged certification. Do not jump straight to a `10-15k` claim.

### 1. Current-host browser stabilization gate

- protected-HLS deploy gate browser ladder: `1`, `3`, `10`, `25`, `50`, `100`, `250`, `500`, `1000`, `2000`
- broader stabilization checkpoints can still focus on `50`, then `100`, then `250` once the smaller playback gate stages are already green
- helper:

```bash
QA_BASE_URL=https://app.example.com \
./scripts/run-recorded-browser-ladder.sh
```

Default stages:

- `QA_VIDEO_BROWSER_STAGES=1,3,10,25,50,100,250,500,1000,2000`

### 2. Recorded-video synthetic scale gate

- active recorded-video API ladder: `250 -> 500 -> 750 -> 1000`
- helper:

```bash
QA_BASE_URL=https://app.example.com \
./scripts/run-course-video-ladder.sh
```

Defaults:

- `COURSE_VIDEO_LADDER_STAGES=250,500,750,1000`
- `COURSE_LOAD_REPORT_PREFIX_BASE=course-video-scale`

### 3. Mixed app-traffic gate

- mixed app ladder: `2000 -> 5000 -> 10000 -> 15000`
- helper:

```bash
QA_BASE_URL=https://app.example.com \
./scripts/run-platform-scale-ladder.sh
```

Defaults:

- `PLATFORM_LADDER_STAGES=2000,5000,10000,15000`
- video progress on
- heavy write paths such as payment checkout, live, enroll, and profile update off by default
- optional mixed-traffic cohort model:
  - `PLATFORM_LOAD_TRAFFIC_MODEL=5k-mixed`
  - `PLATFORM_LOAD_BROWSE_READ_PERCENT=70`
  - `PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT=15`
  - `PLATFORM_LOAD_AUTH_SESSION_PERCENT=10`
  - `PLATFORM_LOAD_LIGHT_WRITE_PERCENT=5`

### One-command `5k` mixed certification path

```bash
QA_BASE_URL=https://app.example.com \
QA_COURSE_TEXT='Course name' \
QA_LESSON_TEXT='Lesson name' \
QA_WATCH_LIMIT_COURSE_ID=course_id \
QA_WATCH_LIMIT_LESSON_ID=lesson_id \
./scripts/run-5k-mixed-readiness.sh
```

## Acceptance before any future `10-15k` claim

Do not claim `10-15k` mixed traffic until:

- recorded video is clean through at least `1000` active recorded-video synthetic users
- recorded video is clean through real-browser `250`
- mixed app load is clean through at least `10000`
- there are no restart loops
- there are no repeated `5xx`
- DB and Redis stay below saturation
- recorded-video startup remains stable under mixed load
- the architecture no longer depends on one host carrying app, media gateway, Postgres, and Redis together

## Practical recommendation

Treat the current single-host production shape as a stabilization platform, not the final high-scale architecture.

Immediate next order:

1. finish the current recorded-video startup and reconnect stabilization
2. prove browser `50`, then `100`, then `250`
3. prove synthetic recorded-video `250`, `500`, `750`, `1000`
4. prove mixed app traffic `2000`, `5000`, `10000`
5. only then size the final replica counts for a real `10-15k` mixed-traffic claim
