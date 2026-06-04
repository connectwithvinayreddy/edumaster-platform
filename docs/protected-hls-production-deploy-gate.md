# Protected-HLS Production Deploy Gate

Production deployment is blocked for any release that changes protected-HLS or recorded-video playback behavior until the real-browser `2,000` streaming-user gate passes.

This gate is **playback-only**. It does not apply to unrelated releases.

## Required certification path

Run the staging-first findings runner:

```bash
ENV_FILE=.env.staging.private-mirror \
QA_BASE_URL=https://app.46.225.218.53.nip.io \
QA_STREAM_CERT_TARGETS_FILE=qa-automation/stream-cert-targets.example.json \
./scripts/run-2k-findings-first-validation.sh
```

The protected-HLS browser ladder must pass in this order:

- `1`
- `3`
- `10`
- `25`
- `50`
- `100`
- `250`
- `500`
- `1000`
- `2000`

Each stage must pass before moving to the next stage. On failure:

- stop
- collect screenshots, logs, metrics, and worker artifacts
- fix the blocker
- rerun from the failed stage

## Deploy-blocking pass criteria

Production deploy is allowed only if the last certification proves:

- `2000` real browser streaming users passed
- `0` false `Playback stopped`
- `0` repeated retry loops
- `0` false tab/device conflicts
- `0` valid-user manifest failures
- `0` valid-user segment failures
- `0` currentTime no-advance failures
- `0` false completion or watch-count corruption
- `0` unauthorized HLS leakage
- no backend restart loop or repeated `502/503/504/525`
- DB, Redis, cache, and containers stayed stable

API-only or synthetic-only testing can support diagnosis, but it never counts as deploy approval for this gate.

## Required artifacts

The findings runner now writes:

- `reports/.../2k-findings-first-summary.json`
- `reports/.../protected-hls-playback-deploy-gate-summary.json`

The browser-farm runner also writes:

- `reports/.../browser-farm-certification-summary.json`

The deploy gate summary must disclose:

- exact real-browser count
- exact synthetic/API diagnostic count
- per-stage pass/fail
- final `deploy approved or blocked` verdict

## Production deploy contract

Playback deploys must not proceed automatically after green.

After the `2k` gate passes:

1. review the final report and artifacts
2. confirm the remaining warnings are acceptable
3. provide explicit approval
4. run production deploy with the gate enabled

Example:

```bash
PLAYBACK_DEPLOY_GATE_ENFORCED=1 \
PLAYBACK_DEPLOY_GATE_SUMMARY=/absolute/path/to/reports/.../protected-hls-playback-deploy-gate-summary.json \
PLAYBACK_DEPLOY_GATE_MANUAL_APPROVAL=1 \
./infra/lowcost/safe-production-deploy.sh
```

`safe-production-deploy.sh` will refuse to continue unless:

- the gate summary exists
- the summary says the required `2000` stage passed
- the run used real browser users only
- there are no blocking failures
- manual approval is explicitly provided
