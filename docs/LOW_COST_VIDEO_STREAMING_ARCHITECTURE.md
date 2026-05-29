# Low-Cost Video Streaming Architecture

## Goal

Build EduMaster for:

- low monthly cost
- smooth video playback for `500` to `1,000` students
- one-to-many live classes without routing media through the main Node app
- private recorded lessons with adaptive HLS playback
- future growth without locking the app into an expensive managed video bill from day one

## Final Recommendation

Use this production shape:

```text
Students
  |
  v
Cloudflare
- DNS
- SSL
- WAF / proxy
- cache for public HLS live delivery
  |
  +-----------------------------+
  |                             |
  v                             v
Hetzner App Stack           Live HLS Origin
- React app                 - nginx-rtmp / MediaMTX
- Node backend              - RTMP ingest from OBS
- Postgres                  - HLS output for viewers
- Redis                     - replay recording files
- workers
  |
  v
Cloudflare R2
- protected lesson HLS assets
- replay storage
- thumbnails / side assets
```

This is the best low-cost path for this repo because it keeps:

- app logic on Hetzner
- heavy lesson/replay storage off the app server
- repeated public live playback away from the backend hot path

## Product Split

### 1. App plane

Runs on Hetzner and owns:

- auth
- enrollments
- lessons and course metadata
- payments
- admin workflows
- live class scheduling
- entitlement checks
- watch progress

### 2. Media plane

Owns:

- raw uploads
- HLS transcoding
- lesson playback manifests
- live RTMP ingest
- live HLS output
- replay import

### 3. Delivery plane

Owns:

- Cloudflare DNS
- HTTPS
- proxying
- cache for public live HLS playback
- stable student playback URLs

## Why This Fits The Existing Repo

The repo already contains the major building blocks:

- low-cost live stack in [infra/lowcost/README.md](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/README.md)
- recorded HLS cache layer in [infra/lowcost/recorded-hls-cache/nginx.conf](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/recorded-hls-cache/nginx.conf)
- protected lesson playback token flow in [backend/lib/repositories.js](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/backend/lib/repositories.js)
- S3-compatible storage support in [backend/lib/private-video-storage.js](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/backend/lib/private-video-storage.js)
- HLS client tuning in [src/lib/hlsPlaybackTuning.ts](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/src/lib/hlsPlaybackTuning.ts)

That means the right move is not a total rewrite. It is finishing and hardening the low-cost architecture that is already partially here.

## Streaming Strategy

### Recorded lessons

Use:

- Cloudflare R2 for object storage
- HLS output at `360p`, `480p`, and `720p`
- signed bootstrap playback URLs
- cached manifests and long-cache immutable segments
- `VIDEO_HLS_STORAGE_PROVIDER=s3` in production

Flow:

1. Admin uploads lesson video
2. Backend stores source temporarily
3. Worker transcodes to HLS ladder
4. HLS assets move to R2
5. Lesson metadata stores storage paths and readiness state
6. Student requests player bootstrap
7. Backend checks entitlement and issues protected playback URL
8. Player fetches HLS manifests and segments through the cache/gateway layer

### Live classes

Use:

- OBS or teacher encoder
- RTMP ingest on `live.varonenglishapp.in`
- nginx-rtmp or MediaMTX on Hetzner
- HLS output on the `live` subdomain
- Cloudflare proxy in front of the `live` subdomain
- replay importer to convert recordings into course content

Flow:

1. Admin starts live class in app
2. Teacher publishes RTMP stream
3. HLS manifests and segments are produced on the live origin
4. Students join using public HLS playback URL
5. Replay importer moves ended recordings into protected course replay storage

### Interactive classes

Do not optimize for this in phase one.

If you later need:

- student mic
- student camera
- breakout style sessions
- teacher controls with active speakers

then add LiveKit only for those classes. Keep mass-viewer delivery on HLS.

## Non-Negotiable Anti-Buffering Rules

1. Never serve large MP4 playback directly from the Node API.
2. Always publish adaptive HLS, not single-bitrate files.
3. Keep lesson renditions at least `360p`, `480p`, and `720p`.
4. Keep live teacher bitrate around `2500-3500 kbps`.
5. Keep HLS segment duration around `4-6` seconds.
6. Keep `app` traffic and `live` traffic on separate subdomains.
7. Put Cloudflare in front of both `app` and `live`.
8. Store recorded media outside the app server disk for production durability.

## Domain Layout

- `app.varonenglishapp.in`
  - website
  - backend API
  - protected lesson bootstrap routes

- `live.varonenglishapp.in`
  - live HLS playback
  - RTMP ingest

## Data Layer

### Postgres

Use Postgres for:

- users
- enrollments
- course metadata
- lesson metadata
- watch progress
- payments
- live class scheduling

### Redis

Use Redis for:

- short-lived player bootstrap caching
- rate limiting
- active live presence
- counters
- live coordination improvements
- manifest cache assists where appropriate

### R2

Use R2 for:

- lesson HLS bundles
- replay HLS bundles
- thumbnails
- subtitles later

## What Big Apps Usually Do

Apps like large edtech platforms generally separate:

- app/backend traffic
- video processing
- CDN delivery

They do not keep the application server as the long-term byte-serving layer for all student playback. This architecture follows that pattern while keeping costs closer to a custom stack than a fully managed premium video platform.

## Recommended Production Shape For This Repo

### Phase 1: Lowest-risk launch

- Hetzner app stack
- Cloudflare DNS/SSL/proxy
- current managed live HLS stack
- current protected HLS lesson flow
- temporary local private video storage only for testing

### Phase 2: Low-cost production hardening

- switch recorded lesson storage from local to Cloudflare R2
- validate course-video load at `250`, `500`, `750`, `1000`
- validate live HLS playback on the `live` domain
- ensure Cloudflare proxy is active for `app` and `live`

### Phase 3: Scale hardening

- move more live state to Redis
- tighten replay import and monitoring
- add dashboards for bootstrap latency, manifest latency, segment errors, and buffer events

## Repo Implementation Plan

### Now

1. Keep the existing Hetzner + Cloudflare deployment path.
2. Keep HLS playback as the default for scale-sensitive lessons and live classes.
3. Prepare R2-backed recorded lesson storage as the main production mode.
4. Set `VIDEO_HLS_STORAGE_PROVIDER=s3` so processed course playback assets land in object storage even if temporary source handling differs.

### Next code work

1. Harden recorded lesson HLS storage and migration paths.
2. Remove remaining assumptions that local storage is acceptable for production lessons.
3. Add stronger operational docs and verification scripts for:
   - R2-backed course video playback
   - Cloudflare-proxied live delivery
   - replay import correctness

## Recorded Video Rollout Steps

1. Set these production env values:
   - `PRIVATE_VIDEO_STORAGE_PROVIDER=s3`
   - `VIDEO_HLS_STORAGE_PROVIDER=s3`
   - `S3_BUCKET`
   - `S3_REGION=auto`
   - `S3_ENDPOINT`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
2. Validate production config with `npm run validate:production`.
3. For existing course videos already on local disk, dry-run the migration:
   - `npm --prefix backend run storage:migrate:course-videos -- --help` is not required; use env flags instead.
   - `MIGRATE_DRY_RUN=true npm --prefix backend run storage:migrate:course-videos`
4. Run the real migration:
   - `npm --prefix backend run storage:migrate:course-videos`
5. Optionally delete local files after confirming playback:
   - `MIGRATE_DELETE_LOCAL=true npm --prefix backend run storage:migrate:course-videos`
6. Backfill manifest bundles if needed:
   - `npm --prefix backend run manifest:backfill`
7. Verify protected lesson playback as a student on HLS-enabled lessons.

### Later

1. Add LiveKit only for interactive premium rooms.
2. Add richer live Redis state to reduce multi-instance fragility.
3. Add media observability dashboards.

## Cost Model Direction

This architecture is designed to stay closer to:

- one Hetzner server bill
- Cloudflare free DNS/proxy
- low R2 storage cost

instead of:

- per-minute managed streaming cost on every viewer minute

That is why this is the recommended fit for a low-cost custom platform.
