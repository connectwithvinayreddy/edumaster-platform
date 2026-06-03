# Course Video Production Architecture

## Goal

Support a production course platform with:

- many videos per course
- low-cost storage on Hetzner
- protected lesson playback
- predictable low-cost scaling toward the current `~1k` recorded-video class
- minimal load on the main Node app

> Current honest verdict: this low-cost single-host direction is still not proven for `3-5k` mixed traffic and is far from a `10-15k` mixed-traffic claim. See `docs/capacity-verdict-and-10k-mixed-traffic-plan.md` for the evidence, target architecture, and scale gates.

## Recommended Hetzner Architecture

For the cheapest practical `5k` mixed-traffic infrastructure path, do **not** force an immediate video-storage migration just because this long-term architecture prefers object storage. Split the overloaded production roles first and keep the current recorded-video provider/storage path during the first scaling phase. The phased cost recommendation lives in:

- `docs/cheapest-practical-5k-infrastructure-plan.md`

### 1. Storage

Use **object storage** as the long-term source of truth for video assets.

Why:

- S3-compatible
- cheap for large video libraries
- better fit than keeping growing media on the app server disk
- immutable object model matches HLS output well
- easier to back up, migrate, and scale than local files

Store:

- original upload
- transcoded HLS variants
- thumbnails
- captions
- metadata sidecars if needed

Do not use the app server filesystem as the long-term primary media store except for temporary upload/transcode workspace.

### 2. Video Format

Standardize every recorded lesson to:

- HLS
- 480p + 720p minimum
- AAC stereo audio
- 4-6 second segments
- VOD playlist with `#EXT-X-ENDLIST`

Optional later:

- 1080p for premium courses
- subtitle tracks
- poster sprite sheets

### 3. App Layer

Split responsibilities:

- **App API**:
  - auth
  - entitlement
  - course metadata
  - lesson player bootstrap
  - watch progress

- **Media Gateway / Cache**:
  - serves HLS manifests
  - redirects segments to object storage
  - caches shared manifests
  - shields app from repeated media fetches

- **Workers**:
  - transcode jobs
  - replay import
  - watch aggregation

The app should authorize access once, then get out of the hot path as much as possible.

### 4. Delivery Flow

Target playback flow:

1. Client requests lesson player from API
2. API validates enrollment and sequential unlock
3. API returns protected master manifest URL
4. Media gateway serves rewritten child manifests
5. Segments are fetched via compact signed URLs and redirected to object storage
6. Progress updates go back to API asynchronously

Key principle:

- **main app handles entitlement**
- **cache/gateway handles repeated HLS traffic**
- **object storage serves the heavy bytes**

### 5. Horizontal Scaling

Run at least:

- `2` app instances
- `1` cache/gateway instance
- `1` watch worker
- `1` replay importer
- `1` postgres
- `1` redis

Rules:

- only one app instance should run singleton background processes
- all app instances should be stateless
- session validity must live in Redis/Postgres, not process memory

### 6. Database and Cache

Postgres:

- source of truth for users, enrollments, lessons, watch progress

Redis:

- short TTL course lookups
- active enrollment cache
- user progress cache
- media manifest cache
- rate limiting

Avoid:

- loading broad platform snapshots in hot paths
- per-request expensive rank/rebuild logic in viewer paths

### 7. Cost-Oriented Choices

For your use case, cheapest production-safe order is:

1. split Postgres and Redis off the current overloaded production box
2. add app and media replicas
3. cache shared HLS manifests aggressively
4. keep the current working recorded-video provider/storage path during the first infra split
5. standardize on the long-term object-storage hot path only after load evidence justifies the migration

Do not optimize for:

- app-server local disk as permanent media store
- Node serving full video payloads directly
- per-viewer unique huge manifest rewriting

### 8. Security Model

Use:

- private object storage bucket
- signed short bootstrap manifest
- compact signed child HLS URLs
- no public raw object keys in the app database response

Optional stronger model later:

- dedicated media subdomain
- secure-link style Nginx validation
- token binding by lesson/course only
- optional IP scoping for enterprise deployments

### 9. Observability

Track separately:

- player bootstrap latency
- master manifest latency
- child/media manifest latency
- first segment latency
- segment redirect latency
- segment cache hit ratio
- object storage egress
- app CPU/memory
- Caddy and media gateway upstream failures

Without this split, video issues get mixed into API issues and are harder to fix.

## Current Repo Direction

This repo already moved toward the right architecture:

- compact signed HLS child URLs
- shared compact HLS master manifest URLs
- dedicated recorded HLS cache layer
- source/rewrite manifest caching
- in-memory + Redis manifest cache layering
- cached signed S3 redirect reuse for repeated segment fetches
- dual app instances
- singleton worker gating

Files involved:

- `backend/course/course.controller.js`
- `backend/lib/private-video.js`
- `backend/lib/repositories.js`
- `backend/server.cjs`
- `infra/lowcost/Caddyfile`
- `infra/lowcost/recorded-hls-cache/nginx.conf`
- `infra/lowcost/docker-compose.prod.yml`

## Next Production Steps

### Phase 1

- complete media gateway offload for child manifests
- ensure cache headers and cache keys match compact HLS route
- deploy shared-master-manifest and shared-segment-redirect optimizations
- validate 250 concurrent viewers cleanly with playback-only reruns

### Phase 2

- rerun 250 -> 500 -> 750 -> 1k course-video load
- measure media manifest latency and cache hit ratio
- tune object storage redirect TTL and gateway cache TTL

### Phase 3

- introduce dedicated media domain
- move course media path fully behind gateway rules
- add dashboarding for viewer startup and segment timings

## Practical Recommendation

For a low-cost Hetzner production setup with many course videos:

## Validation Workflow

Use the dedicated course-video load runner in `qa-automation`:

1. Prepare synthetic users once:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS=750 COURSE_LOAD_SETUP_CONCURRENCY=3 COURSE_LOAD_PREPARE_ONLY=true npm --prefix qa-automation run load:course-video`
2. Reuse the generated `prepared-users.json` to avoid signup noise:
   `QA_BASE_URL=https://app.178.105.48.179.nip.io COURSE_LOAD_USERS=250 COURSE_LOAD_ACTIVE_CONCURRENCY=250 COURSE_LOAD_USERS_FILE=/absolute/path/to/prepared-users.json npm --prefix qa-automation run load:course-video`
3. Repeat for `500`, `750`, then `1000`.

This gives cleaner playback numbers because the viewer path is isolated from account-creation overhead.

- keep app/API on Hetzner cloud servers
- keep videos in Hetzner Object Storage
- keep Redis and Postgres close to app
- use Nginx/Caddy as media gateway and cache
- never make the Node API the byte-serving layer for steady-state playback

That is the best balance of:

- cost
- operational simplicity
- scaling headroom
- future growth for more courses and more videos
