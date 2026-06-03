# Hetzner + Cloudflare Low-Cost Live Stack

This is the recommended production stack for EduMaster when:

- cost matters more than ultra-low latency
- one teacher broadcasts to many students
- you want immediate replay after live classes
- you expect up to about `1000` concurrent viewers per class

It is a low-cost starting point, not a proven `3-5k` mixed-traffic or `10-15k` future-capacity architecture. For the current verdict, the nearer-term `5k` mixed-certification path, and the upgrade plan, see:

- `docs/5k-mixed-traffic-readiness-plan.md`
- `docs/cheapest-practical-5k-infrastructure-plan.md`
- `docs/capacity-verdict-and-10k-mixed-traffic-plan.md`

## Stack

- `Hetzner dedicated server`
  - Node.js app
  - PostgreSQL
  - Redis
  - MediaMTX RTMP + HLS origin
- `Cloudflare proxy/cache`
  - `app.example.com` -> app
  - `live.example.com` -> HLS origin
- `Cloudflare R2`
  - archived protected recordings
- `Hetzner Storage Box`
  - backups

## Files

- [Caddyfile](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/Caddyfile)
- [docker-compose.prod.yml](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/docker-compose.prod.yml)
- [mediamtx.yml](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/mediamtx.yml)
- [.env.hetzner-cloudflare.example](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/.env.hetzner-cloudflare.example)
- [deploy-hetzner.sh](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/deploy-hetzner.sh)
- [safe-production-deploy.sh](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/safe-production-deploy.sh)
- [backup-to-storage-box.sh](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/infra/lowcost/backup-to-storage-box.sh)

## Domain layout

- `app.example.com`
  - proxied through Cloudflare
  - serves the app and backend API

- `live.example.com`
  - proxied through Cloudflare
  - serves HLS playback
  - accepts RTMP ingest on port `1935`

## First-time server setup

1. Provision a Hetzner Ubuntu `24.04` server.
2. Install Docker Engine and the Compose plugin.
3. Open ports:
   - `80`
   - `443`
   - `1935`
4. Point `app.example.com` and `live.example.com` at the server.
5. Enable Cloudflare proxy for both hostnames.
6. Copy [/.env.production](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/.env.production) from the example template and fill real values.

## Required env values

At minimum set these in [/.env.production](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/.env.production):

- `APP_DOMAIN`
- `LIVE_DOMAIN`
- `APP_URL`
- `CORS_ORIGIN`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `REPLAY_IMPORT_ADMIN_EMAIL`
- `REPLAY_IMPORT_ADMIN_PASSWORD`
- `JWT_SECRET`
- `PRIVATE_VIDEO_TOKEN_SECRET`
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `S3_BUCKET`
- `S3_REGION=auto`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `LIVE_INGEST_PUBLISHER_SECRET`
- `LIVE_HLS_PUBLIC_BASE_URL`

## Deploy

From your local machine:

```bash
chmod +x infra/lowcost/deploy-hetzner.sh
./infra/lowcost/deploy-hetzner.sh root@YOUR_SERVER_IP /opt/edumaster
```

This script:

1. validates the production env
2. builds the frontend locally
3. syncs the repo to the server with `rsync`
4. runs a safe rolling deploy remotely

The remote rolling deploy script:

1. builds the updated Docker images on the server
2. reloads Caddy with the current config
3. updates `app` first and waits for Docker health plus `/api/live`, `/api/ready`, and `/api/health`
4. updates `app-2` only after `app` is fully ready
5. continuously checks public `200` responses during the rollout
6. fails fast if public checks or upstream health checks regress

For large classes, the student player should use the public HLS URL directly so the app server stays out of the per-segment media path.

## Isolated staging private mirror

Use a separate staging host for playback certification before production rollout.

1. Copy [/.env.staging.private-mirror.example](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/.env.staging.private-mirror.example) to `.env.staging.private-mirror`.
2. Replace `203.0.113.10` with the real staging host IP so the mirror serves:
   - `app.<staging-ip>.nip.io`
   - `live.<staging-ip>.nip.io`
3. Or generate the staging env automatically from `.env.production` and the example template:

```bash
./scripts/create-staging-private-mirror-env.sh STAGING_SERVER_IP
```

The generator rewrites the public URLs to `nip.io`, keeps the playback/storage configuration shape aligned with production, and generates fresh staging-only admin, JWT, Postgres, and Redis secrets. It deliberately leaves `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` as placeholders so you must replace them with a staging-only read-only token for the production video bucket before deploy.

4. Point the staging env at an isolated Postgres + Redis copy and reuse the production video bucket read-only for playback fidelity. Do not reuse the production write-capable bucket credentials in staging.
5. Sync the repo to the staging host with the staging env file:

```bash
ENV_FILE=.env.staging.private-mirror \
./infra/lowcost/deploy-hetzner.sh root@STAGING_SERVER_IP /opt/edumaster-staging
```

6. On the staging host, restore a fresh production backup into the isolated staging Postgres and scrub all user-derived data before first boot:

```bash
cd /opt/edumaster-staging
ENV_FILE=/opt/edumaster-staging/.env.staging.private-mirror \
bash ./infra/lowcost/restore-staging-private-mirror.sh /absolute/path/to/production-backup.dump.gz
```

The restore script:
- resets the staging `edumaster` database
- restores the supplied backup
- truncates user-derived tables such as `users`, `user_sessions`, `payments`, `enrollments`, `watch_history`, `video_watch_states`, `notifications`, `lesson_doubt_*`, `lesson_reports`, and related live replay/chat rows
- flushes staging Redis
- inserts one staging-only admin directly into `users` using `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_NAME` from the selected env file
- starts the full staging stack again by default
- refuses to run if the selected env file looks like production or if the staging DB/Redis URLs match local production env values

Set `STAGING_KEEP_LIVE_CLASSES=true` only if the mirror needs to preserve `live_classes` rows for a separate live test pass. The default is `false`.

The low-cost deploy scripts now honor `ENV_FILE` and pass that same env file through the local validation step, compose interpolation, remote container env injection, and rolling deploy checks. The staging gate also refuses obvious production-like targets such as `.env.production`, non-`nip.io` domains, or a `QA_BASE_URL` that matches the local production app domain.

After the mirror is live, run the browser gate from the local repo checkout against the staging URL:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.<staging-ip>.nip.io \
bash ./scripts/run-staging-private-mirror-gate.sh
```

The staging gate now:
- exports the selected env file into the QA process environment
- checks repeated `200` responses for `/`, `/backend/api/live`, `/backend/api/ready`, and `/backend/api/health`
- checks that repeated `/` responses serve the same entry bundle hash
- prepares a synthetic QA browser user manifest automatically when one is not supplied
- uses the first prepared QA student for the single-user playback root-cause proof instead of falling back to the admin login
- writes wrapper logs under `reports/staging-private-mirror-gate-*`

Optional follow-up stages can be triggered from the same entrypoint:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.<staging-ip>.nip.io \
RUN_WATCH_LIMIT=1 \
RUN_HYBRID_3K=1 \
bash ./scripts/run-staging-private-mirror-gate.sh
```

For the `4k` stretch gate:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.<staging-ip>.nip.io \
RUN_HYBRID_3K=1 \
RUN_HYBRID_4K=1 \
bash ./scripts/run-staging-private-mirror-gate.sh
```

The hybrid stages reuse the existing platform mixed-load harness as the diagnostic cohort and pair it with real browser video viewers in parallel.

## Separate staging VPS workflow

Do not use the production host IP as the staging mirror target. Provision a separate staging VPS and use the helper scripts in this order:

1. Optionally bootstrap a fresh Ubuntu host with Docker and prepare `/opt/edumaster-staging`:

```bash
bash ./scripts/bootstrap-separate-staging-vps.sh root@STAGING_SERVER_IP /opt/edumaster-staging
```

2. Create a fresh production Postgres dump on the live host:

```bash
bash ./scripts/export-production-postgres-backup.sh root@178.105.48.179
```

3. Or run the full separate-VPS flow end to end:

```bash
bash ./scripts/deploy-separate-staging-mirror.sh root@STAGING_SERVER_IP STAGING_SERVER_IP
```

The orchestration script will:
- generate `.env.staging.private-mirror` if needed
- refuse to continue until the staging env uses staging-only read-only S3 credentials instead of placeholders or production credentials
- deploy the repo to the staging VPS
- create a fresh read-only production Postgres backup on `root@178.105.48.179`
- stream that dump to the staging VPS
- run the staging restore and scrub
- run a staging HTTPS health check
- print the next browser-gate command

## OBS publish settings

- `Server`: `rtmp://live.example.com:1935/live`
- `Stream Key`: `<liveClassId>__<courseId>__<moduleId>__<chapterId_or_root>`
- `Keyframe interval`: `2`
- `FPS`: `30`
- `Video bitrate`: `2500-3500 kbps`

The first part of the key must be the live class ID. The full key is used for replay import so the recording can be attached back into the correct course/module after the class ends. The shared ingest secret is enforced server-side through the RTMP `on_publish` callback and does not need to be appended to the stream key.

## Real live-class verification

After deployment:

1. log in as admin
2. create an `hls` live class
3. click `Start Live Class`
4. publish from OBS using the generated stream key
5. log in as a student
6. join the same class
7. verify audio/video plays for at least `2-3` minutes
8. end the class
9. open the replay immediately from the student side

## Backup

Run nightly on the server:

```bash
chmod +x infra/lowcost/backup-to-storage-box.sh
STORAGE_BOX_HOST=u123456.your-storagebox.de \
STORAGE_BOX_USER=u123456 \
infra/lowcost/backup-to-storage-box.sh
```

This exports:

- Postgres database dump
- app private uploads
- app upload state

## Important note

I can prepare and validate everything in this repo, but the actual Hetzner deployment and real OBS publish test require:

- a real server IP or SSH target
- the final domain names
- Cloudflare DNS/proxy in place
- R2 credentials
- your filled production env

## Service Details To Share

Do not paste passwords into chat unless you are comfortable doing so. For final deployment, prepare these values in `.env.production` or your hosting secret manager:

- `APP_DOMAIN`, for example `app.varonenglish.com`
- `LIVE_DOMAIN`, for example `live.varonenglish.com`
- Hetzner server IP and SSH target, for example `root@1.2.3.4`
- Cloudflare zone/domain access, or confirmation DNS is pointed and orange-cloud proxied
- Cloudflare R2 bucket name, account ID, endpoint, access key ID, and secret access key
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `JWT_SECRET`
- `PRIVATE_VIDEO_TOKEN_SECRET`
- `LIVE_INGEST_PUBLISHER_SECRET`
- production admin email/password
- replay importer admin email/password, usually the same admin account
