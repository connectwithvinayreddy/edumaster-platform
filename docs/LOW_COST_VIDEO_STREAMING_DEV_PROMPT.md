# Low-Cost Video Streaming Implementation Prompt

Use this prompt when continuing implementation work for the EduMaster streaming stack.

```text
You are implementing the low-cost production video architecture for the EduMaster app.

Business goal:
- Keep monthly infra cost low
- Support 500 to 1000 students with smooth lesson playback and one-to-many live classes
- Avoid routing repeated video bytes through the main Node backend

Architecture to follow:
- Hetzner runs the main app, backend, Postgres, Redis, workers, and live HLS origin
- Cloudflare provides DNS, SSL, proxy, and edge caching
- Cloudflare R2 stores protected recorded lesson and replay HLS assets
- VIDEO_HLS_STORAGE_PROVIDER should be s3 in production
- Live HLS playback stays on live.varonenglishapp.in
- App/API traffic stays on app.varonenglishapp.in
- Adaptive HLS is the default playback strategy
- LiveKit is optional and should only be used for future interactive classrooms, not the default viewer path

Current repo anchors:
- infra/lowcost/docker-compose.prod.yml
- infra/lowcost/Caddyfile
- infra/lowcost/recorded-hls-cache/nginx.conf
- backend/lib/private-video-storage.js
- backend/lib/repositories.js
- backend/course/course.controller.js
- backend/live/live.controller.js
- src/lib/hlsPlaybackTuning.ts

Implementation rules:
- Do not introduce expensive managed streaming assumptions
- Prefer Cloudflare R2 over local app-server storage for production lesson assets
- Keep the backend responsible for entitlement and bootstrap only
- Keep repeated HLS manifest and segment traffic off the main app process whenever possible
- Preserve the existing low-cost Hetzner deployment path
- Maintain compatibility with current env vars unless there is a strong reason to add new ones

Priorities:
1. Strengthen R2-backed lesson playback and replay storage
2. Reduce any remaining direct byte-serving dependency on the Node backend
3. Improve live-state correctness for multi-instance deployment where practical
4. Preserve or improve current HLS startup and buffering behavior
5. Keep changes production-oriented, testable, and documented

When making changes:
- explain which part of the architecture the change supports
- prefer incremental refactors over full rewrites
- include verification steps
- call out any remaining production risks
```

## Suggested First Work Items

1. Audit remaining production paths that still assume `PRIVATE_VIDEO_STORAGE_PROVIDER=local`.
2. Tighten R2-backed replay import and manifest storage behavior.
3. Add or improve load-test instructions for course-video playback at `250`, `500`, `750`, and `1000` users.
4. Move more live coordination state out of process memory where safe to do incrementally.
5. Keep the course-video migration script usable for moving existing local assets into R2.
