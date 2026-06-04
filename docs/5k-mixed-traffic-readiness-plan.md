# `5k` Mixed-Traffic Readiness Plan

## Target

The first production-scale target is:

- `5000` concurrent total users
- mixed desktop/mobile/browser traffic
- recorded-video playback included
- about `10-20%` active recorded-video users at the same time

This plan does **not** mean `5000` simultaneous recorded-video viewers. That is a later, heavier media-scale phase.

## Current honest verdict

With the current production evidence:

- the stack is **not yet ready** for `5000` mixed concurrent users
- the current single-host shape should **not** be trusted for that claim
- recorded lessons remain the first important blocker

See:

- `docs/protected-hls-production-deploy-gate.md`
- `docs/capacity-verdict-and-10k-mixed-traffic-plan.md`
- `docs/cheapest-practical-5k-infrastructure-plan.md`

## Protected-HLS deploy gate before any playback rollout

For releases that change protected-HLS or recorded-video playback behavior:

- production deploy is blocked until the real-browser `2,000` streaming-user gate passes
- API-only and synthetic-only checks are diagnostic only
- the required protected-HLS browser ladder is:
  - `1 -> 3 -> 10 -> 25 -> 50 -> 100 -> 250 -> 500 -> 1000 -> 2000`

See:

- `docs/protected-hls-production-deploy-gate.md`

## Findings-first `2k` gate before `5k`

Before any `5k` claim, run the findings-oriented `2k` validation loop:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.46.225.218.53.nip.io \
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
./scripts/run-2k-findings-first-validation.sh
```

This stage:

- captures baseline host snapshots for staging and prod
- runs targeted correctness checks first
- runs protected-HLS browser `1 -> 3 -> 10 -> 25 -> 50 -> 100 -> 250 -> 500 -> 1000 -> 2000`
- runs recorded-video synthetic `250 -> 500 -> 750 -> 1000`
- runs mixed app `500 -> 1000 -> 1500 -> 2000`
- stops on first failure and records a normalized finding with snapshots, logs, and a fix bucket

## Required traffic model

The certification target for the mixed app plane is:

- `70%` browse/read/dashboard/catalog/test-list traffic
- `15%` active recorded-video traffic
- `10%` auth/session/notifications/profile-light traffic
- `5%` light-write traffic

The platform load runner now supports this explicitly through:

- `PLATFORM_LOAD_TRAFFIC_MODEL=5k-mixed`
- `PLATFORM_LOAD_BROWSE_READ_PERCENT=70`
- `PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT=15`
- `PLATFORM_LOAD_AUTH_SESSION_PERCENT=10`
- `PLATFORM_LOAD_LIGHT_WRITE_PERCENT=5`

## Required certification order

Do not jump straight to `5000` mixed traffic. Run the gates in this order:

1. Recorded-video root-cause regressions
2. Recorded-video real-browser ladder
   - `50`
   - `100`
   - `250`
3. Recorded-video synthetic ladder
   - `250`
   - `500`
   - `750`
   - `1000`
4. Mixed app ladder
   - `2000`
   - `5000`

## One-command certification wrapper

From the repo root:

```bash
QA_BASE_URL=https://app.example.com \
QA_COURSE_TEXT='SSC CGL' \
QA_LESSON_TEXT='INTRODUCTION' \
QA_WATCH_LIMIT_COURSE_ID=course_id_here \
QA_WATCH_LIMIT_LESSON_ID=lesson_id_here \
./scripts/run-5k-mixed-readiness.sh
```

The wrapper:

- runs desktop and mobile root-cause playback regressions
- runs watch-limit and smooth-playback regressions
- runs recorded-browser stages `50 -> 100 -> 250`
- runs recorded-video synthetic stages `250 -> 500 -> 750 -> 1000`
- runs mixed-platform stages `2000 -> 5000`
- pins the mixed app load profile to `70/15/10/5`

Useful controls:

- `FIVE_K_MIXED_DRY_RUN=1`
- `FIVE_K_SKIP_ROOTCAUSE=1`
- `FIVE_K_SKIP_WATCH_LIMIT=1`
- `FIVE_K_SKIP_SMOOTH_PLAYBACK=1`
- `FIVE_K_SKIP_RECORDED_BROWSER=1`
- `FIVE_K_SKIP_RECORDED_SYNTHETIC=1`
- `FIVE_K_SKIP_PLATFORM=1`

## Mixed app-load expectations

At `5000` concurrent mixed users, the pass bar is:

- no repeated `5xx`
- no restart loops
- DB and Redis below saturation
- dashboard, course, lesson, and test routes remain usable
- active recorded-video cohort remains stable under mixed traffic
- no single tier becomes the obvious bottleneck

The mixed app runner is still API/load automation, not true `5000` real-browser proof. Browser/device proof stays in the recorded-video browser ladder.

## Required architecture before a true `5k` claim

Do not claim `5000` mixed users while the production blast radius is still one box carrying:

- app replicas
- Postgres
- Redis
- manifest/gateway/cache
- workers

The target low-cost split is:

- Cloudflare edge
- `4-6` app replicas
- `2` manifest-app instances
- `2` recorded HLS gateway/cache instances
- dedicated Postgres with pooling
- dedicated Redis
- separate worker tier

For the cheapest phased budget and the recommended Hetzner node mix, see:

- `docs/cheapest-practical-5k-infrastructure-plan.md`

## Not included in this phase

This plan does **not** certify:

- `5000` simultaneous recorded-video viewers
- `10000-15000` mixed users
- live-class media scale

Those remain later phases after recorded-video and `5000` mixed traffic are both green.
