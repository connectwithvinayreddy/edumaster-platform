# Recorded Video QA Prompt

Validate and harden recorded course video playback for EduMaster.

Current verified state:
- Recorded MP4 upload attaches correctly to the selected course, module, and chapter.
- HLS processing completes and serves a signed master manifest.
- Student playback works in-browser with HLS.js.
- Manual quality control is exposed for supported browsers.
- Signed HLS delivery now requires both:
  - a valid signed HLS URL
  - a same-origin playback grant cookie issued from the protected lesson player endpoint
- Tampered manifest signatures are rejected.
- Copied manifest, media-playlist, and segment URLs without the playback grant cookie are rejected.
- Recent local perf probe results:
  - heading ready: ~1.4s
  - video visible: ~2.0s
  - first frame: ~2.6s
  - manifest failures: 0
  - segment failures: 0
  - total buffered wait during short watch: ~2.4s

Recent implementation changes:
- Faster course boot path in `src/App.tsx`
- HLS.js-first quality handling in course players
- More robust recorded-video perf automation in `qa-automation/src/course-video-perf-probe.ts`
- Case filtering for targeted playback QA in `qa-automation/src/course-video-production-qa.ts`

Remaining follow-up questions:
1. Decide whether the current signed-URL plus playback-cookie model is enough for production.
   - It is stronger than signed URL alone and still browser-compatible.
   - You may still want shorter grant expiry in production.
2. Decide whether you want per-session or per-device grant rotation beyond the current session-aware cookie.
3. Decide whether the browser `Permissions-Policy` warning for `speaker-selection` should be removed to keep QA logs cleaner.

Required checks:
1. Confirm uploads still land in the intended provider and path.
2. Confirm lesson playback remains attached to the correct course/module/chapter.
3. Confirm HLS master and media playlists load and start within acceptable time.
4. Confirm quality switch between Auto and available levels does not stall playback.
5. Confirm manifest tampering returns 401.
6. Confirm valid signed HLS asset URLs without the playback cookie return 401.
7. Confirm the intended security stance for playback grants is documented and enforced.
8. Confirm QA matrix filtered playback cases run serially when reusing a single student account.

Useful commands:
```bash
QA_BASE_URL=http://127.0.0.1:3300 \
QA_LOGIN_EMAIL=student@varoonenglish.com \
QA_LOGIN_PASSWORD='Student@123' \
QA_COURSE_ID=course_4eb8eb4877fa4bcf98148e051b2c98f2 \
QA_LESSON_ID=video_1779022808443 \
npm --prefix qa-automation run browser:course-video-perf
```

```bash
QA_BASE_URL=http://127.0.0.1:3300 \
QA_LOGIN_EMAIL=student@varoonenglish.com \
QA_LOGIN_PASSWORD='Student@123' \
COURSE_LOAD_COURSE_ID=course_4eb8eb4877fa4bcf98148e051b2c98f2 \
COURSE_LOAD_LESSON_ID=video_1779022808443 \
PLAYBACK_QA_SKIP_LOAD=true \
PLAYBACK_QA_BROWSER_WORKERS=1 \
PLAYBACK_QA_CASE_FILTER='playback-player-init,playback-start,playback-continuity,playback-quality-switch,hls-segment-loading,hls-segment-retry,hls-manifest-timeout,perf-startup-latency,perf-buffering,security-unauthorized-manifest,security-invalid-signature,security-direct-segment' \
npm --prefix qa-automation run qa:course-video:matrix
```
