# Recorded Video Scale Architecture Prompt

Use this prompt when optimizing recorded course video delivery for EduMaster after the latest measured load tests.

## Verified setup

- Course created for test:
  - `courseId=course_86bc6f7cf0354c15ab5ea745c027ba48`
  - `moduleId=module_1779084289290`
  - `chapterId=chapter_1779084289293`
  - `lessonId=video_1779084289910`
- Test asset uploaded:
  - `/Users/anudeepreddypolu/Downloads/Hanuman Chalisa Telugu Lyrics - Raghava Reddy.mp4`
- Recorded video pipeline:
  - upload -> HLS processing -> protected lesson player -> compact HLS routes -> manifest/segment delivery
  - storage provider configured to Cloudflare R2

## Fresh browser playback proof

- Perf artifact root:
  - `/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/qa-automation/qa-automation/artifacts/2026-05-18T06-34-21-717Z`
- Screenshots:
  - `screenshots/01-lesson-shell.png`
  - `screenshots/02-video-visible.png`
  - `screenshots/03-playback-started.png`
- Measured playback:
  - heading ready: `2615 ms`
  - video visible: `3135 ms`
  - first frame: `2778 ms`
  - manifest failures: `0/14`
  - segment failures: `0/16`
  - average manifest latency: `219 ms`
  - average segment latency: `343 ms`
  - buffering events: `1`
  - total buffered wait: `2514 ms`

## Load test findings

### Original path: 500 concurrent students

- Report dir:
  - `/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/reports/english-course-500-r2-2026-05-18T06-23-08-649Z`
- Result:
  - users: `500`
  - successful journeys: `311`
  - failed journeys: `189`
  - total requests: `12272`
  - failed requests: `201`
- Main failures:
  - `GET /backend/api/courses` timed out `189` times
  - `GET /backend/api/courses/:id` timed out `12` times
- Important detail:
  - `course.player` was `100%` successful
  - HLS manifest failures: `0`
  - HLS media manifest failures: `0`
  - HLS segment failures were not a material bottleneck

### Original path: 1000 concurrent students

- Report dir:
  - `/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/reports/english-course-1000-r2-2026-05-18T06-27-06-922Z`
- Result:
  - users: `1000`
  - successful journeys: `331`
  - failed journeys: `669`
  - total requests: `17446`
  - failed requests: `1835`
- Main failures:
  - `GET /backend/api/courses` timed out `639` times
  - `GET /backend/api/courses/:id` timed out `415` times
  - `GET /backend/api/courses/:id/lessons/:lessonId/player` failed `406` times, mostly timeout with a few `403`
  - `GET /backend/api/courses/:id/lessons` timed out `314` times
  - `POST /backend/api/platform/enroll` timed out `55` times
- Important detail:
  - HLS master manifest failures: `1`
  - HLS media manifest failures: `0`
  - HLS segment failures: effectively negligible

### Optimized lesson-bootstrap path: 500 concurrent students

- Report dir:
  - `/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/reports/english-course-500-bootstrap-r2-2026-05-18T07-23-44-778Z`
- Result:
  - users: `500`
  - successful journeys: `500`
  - failed journeys: `0`
  - total requests: `10272`
  - failed requests: `0`
- Main timing:
  - `course.lessonBootstrap` p95: `15206 ms`
  - `course.video.masterManifest` success: `100%`
  - segment delivery success: `100%`

### Optimized lesson-bootstrap path: 1000 concurrent students

- Report dir:
  - `/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/reports/english-course-1000-bootstrap-r2-setup10-2026-05-18T07-50-28-058Z`
- Result:
  - users: `1000`
  - successful journeys: `973`
  - failed journeys: `27`
  - total requests: `20061`
  - failed requests: `27`
- Main timing:
  - `course.lessonBootstrap` p95: `28929 ms`
  - `course.lessonBootstrap` success: `97.3%`
  - HLS manifest success: `100%`
  - segment delivery success: `100%`
- Remaining failures:
  - `21` bootstrap timeouts
  - `6` bootstrap `403` responses

## Measured conclusion

The primary bottleneck is not recorded video segment delivery.

The original primary bottleneck was app-side course bootstrap under login fan-in:

1. `/courses`
2. `/courses/:id`
3. `/courses/:id/lessons`
4. `/courses/:id/lessons/:lessonId/player`

The first failure wave happened before students were fully watching video. In other words, students were mostly getting stuck entering the lesson, not while HLS was already streaming.

After introducing a direct lesson-bootstrap path and short-lived viewer caches, the system improved from:

- `311/500` successful journeys -> `500/500`
- `331/1000` successful journeys -> `973/1000`

That confirms the architecture direction is correct.

## Required optimization goal

Optimize for:

1. fast student lesson entry under 500 to 1000 concurrent opens
2. minimal DB work on course bootstrap
3. stable protected HLS playback once playback starts
4. less repeated metadata fetching per student
5. CDN-friendly media path with app/backend protected only where needed

## Recommended architecture

### Edge and storage

- Cloudflare for:
  - DNS
  - SSL
  - WAF
  - edge caching
- Cloudflare R2 for:
  - processed HLS assets
  - recorded video source/archive if desired

### App tier

- Run app/backend on Hetzner
- Separate concerns:
  - app API service
  - manifest/protected asset service
  - background worker/transcoding service
- Move Postgres and Redis off the single app process bottleneck

### Data/cache tier

- Postgres for source of truth
- Redis for:
  - course entitlement snapshots
  - lesson metadata cache
  - player bootstrap cache
  - short-lived signed playback grants

### Delivery model

- Keep protected player bootstrap on backend
- Keep HLS asset delivery on cached/protected compact routes
- Cache master manifest bundle lookups and lesson metadata aggressively
- Avoid repeated heavy course list queries during lesson open

## Highest priority implementation changes

1. Do not require a full `/courses` list fetch before lesson playback.
2. Keep using the lightweight direct lesson bootstrap path for deep links:
   - entitlement check
   - lesson metadata
   - player payload
3. Cache course detail and lesson tree responses in Redis or in-memory with invalidation.
4. Reduce payload size for student course list responses.
5. Precompute lesson navigation data instead of rebuilding it per request.
6. Add rate-safe enrollment behavior so repeat opens do not trigger redundant writes.
7. Move HLS and manifest service behind a dedicated cache-friendly service or reverse proxy in production.
8. Keep auth refresh/setup concurrency controlled during large fan-in events.

## Prompt for the next implementation pass

```text
Optimize recorded lesson entry and playback startup in EduMaster based on measured load-test evidence.

Facts from the latest run:
- original 500 concurrent users: 311 successful journeys, 189 failed
- original 1000 concurrent users: 331 successful journeys, 669 failed
- optimized bootstrap 500 concurrent users: 500 successful journeys, 0 failed
- optimized bootstrap 1000 concurrent users: 973 successful journeys, 27 failed
- Browser playback for a single student is healthy:
  - heading ready ~2.6s
  - video visible ~3.1s
  - first frame ~2.8s
  - manifest failures 0
  - segment failures 0
- HLS delivery is not the first bottleneck
- Main original bottlenecks were:
  - GET /backend/api/courses
  - GET /backend/api/courses/:id
  - GET /backend/api/courses/:id/lessons
  - GET /backend/api/courses/:id/lessons/:lessonId/player
- Current remaining bottleneck:
  - GET /backend/api/courses/:id/lessons/:lessonId/bootstrap at 1000-concurrency edge

Goal:
- make 500 to 1000 concurrent student lesson opens succeed far more reliably
- reduce timeouts in course bootstrap
- keep protected HLS playback working

Implement:
1. a lightweight direct lesson bootstrap endpoint for student playback
2. caching for course detail, lesson tree, and player bootstrap
3. smaller/faster course list responses for students
4. avoid redundant enroll or progress writes during startup
5. preserve signed URL + playback cookie protections for HLS

Success criteria:
- load tests show dramatic reduction in bootstrap timeouts
- course.player remains protected and stable
- manifest and segment failure rate stays near zero
- browser playback screenshots still show successful playback
```
