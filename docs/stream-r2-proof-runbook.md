# Stream to R2 Proof Runbook

Use this flow before removing Cloudflare Stream from production recorded lessons.

## Emergency protected-HLS rollout

Use this lighter path for an urgent protected-HLS playback fix when production needs a staging proof first, but tonight's deploy should not be blocked on the broader mixed-cert cutover gate.

Targets:
- `Bank / English / DAY3 VERB / VERB`
- `SSC CGL / INTRODUCTION`

Run:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.STAGING_IP.nip.io \
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
PRODUCTION_ENV_FILE=.env.production \
bash ./scripts/run-emergency-protected-hls-rollout.sh
```

What it does:
- runs `run-targeted-functional-proof.sh` on staging for the selected targets
- runs a blocking real-browser ladder at `25,50,100` per target
- deploys production with `infra/lowcost/safe-production-deploy.sh`
- runs `run-production-targeted-smoke.sh`

What it does not do:
- it does **not** use `deploy-stream-r2-cutover.sh`
- it does **not** wait for the broader `250`, `500`, or mixed `500 + 100` staging gates

## 0. Local to staging resolution loop

Run the full localhost -> staging/private-mirror -> production smoke loop with:

- real SSC + Bank target lessons
- exact selected production PDFs copied into non-production `private_uploads`
- read-only real HLS/R2 playback assets
- QA-only users

```bash
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
bash ./scripts/run-local-to-staging-resolution-loop.sh root@STAGING_SERVER_IP STAGING_SERVER_IP
```

Outputs:
- `reports/local-to-staging-resolution-loop-*/resolution-loop-summary.json`
- localhost functional proof artifacts and screenshots
- staging certification artifacts and screenshots
- production smoke artifacts and screenshots

## 1. Localhost proof

Run one real Stream-backed lesson through the migration and verify it plays from protected HLS on localhost:

```bash
ENV_FILE=.env.staging.private-mirror \
bash ./scripts/run-stream-r2-local-proof.sh
```

Outputs:
- `reports/stream-r2-local-proof-*/local-proof-summary.json`
- `reports/stream-r2-proof/latest/local-proof.json`

## 2. Staging/private-mirror proof

Deploy a scrubbed staging mirror, migrate the same lesson, then prove the mirror through the `100`-viewer ladder:

```bash
ENV_FILE_PATH=.env.staging.private-mirror \
bash ./scripts/run-stream-r2-mirror-proof.sh root@STAGING_SERVER_IP STAGING_SERVER_IP
```

Outputs:
- `reports/stream-r2-mirror-proof-*/mirror-proof-summary.json`
- `reports/stream-r2-proof/latest/mirror-proof.json`
- `reports/stream-r2-proof/latest/production-deploy-ready.json`

## 2b. SSC and Bank streaming + PDF certification

Before production deploy, run the two-course R2/custom-HLS certification on the staging/private mirror:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.STAGING_IP.nip.io \
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
bash ./scripts/run-ssc-bank-streaming-pdf-mixed-certification.sh
```

Default staging gate shape:
- browser proof at `100` and `200`
- synthetic mixed `1000 total` and `2000 total`
- synthetic split:
  - `70%` active video
  - `16%` PDF readers
  - `4%` auth/session readers
  - `10%` test readers

Outputs:
- `reports/streaming-pdf-mixed-certification-*/streaming-pdf-mixed-certification-summary.json`
- `reports/streaming-pdf-mixed-certification/latest/streaming-pdf-mixed-certification-summary.json`

## 3. Production cutover deploy

Deploy only from the mirror proof artifact:

```bash
bash ./scripts/deploy-stream-r2-cutover.sh
```

The deploy wrapper refuses to continue unless:
- the mirror proof report says `readyForProductionDeploy=true`
- the proof reached at least `100` real browser viewers
- the SSC/Bank streaming+PDF certification says `readyForProductionDeploy=true`
- both `ssc` and `bank` targets were executed
- the certification included both the `100` and `200` viewer stages
- the certification included both the `1000` and `2000` total-user synthetic stages
- the `2000` synthetic stage required at least:
  - `1400` video users
  - `600` background users
  - `320` PDF readers
  - `80` auth/session readers
  - `200` test readers
