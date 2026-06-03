import fs from 'node:fs';

const [
  stageLabel,
  stageKind,
  logPath,
  preSnapshotPath,
  postSnapshotPath,
  evidencePath,
] = process.argv.slice(2);

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const logText = [readText(logPath), readText(evidencePath)].join('\n').toLowerCase();
const preSnapshot = readJson(preSnapshotPath);
const postSnapshot = readJson(postSnapshotPath);

const snapshotSignals = [preSnapshot, postSnapshot].filter(Boolean);
const restartingContainers = snapshotSignals.flatMap((entry) => entry?.restartingContainers || []);
const unhealthyContainers = snapshotSignals.flatMap((entry) => entry?.unhealthyContainers || []);
const highCpuContainers = snapshotSignals.flatMap((entry) => entry?.highCpuContainers || []);
const highMemContainers = snapshotSignals.flatMap((entry) => entry?.highMemContainers || []);
const badEndpoints = snapshotSignals.flatMap((entry) => (entry?.endpointStatuses || []).filter((status) => status && status.ok === false));

const hasAny = (...patterns) => patterns.some((pattern) => pattern.test(logText));

let classification = 'app_api_saturation';
let requiredFixBucket = 'app_api_bottleneck';
let rerunVerdict = 'rerun_same_stage_after_fix';

if (hasAny(/manifest|m3u8|segment|hls|playback stopped|source_fallback|deliverypath|streamurl|direct_cloudflare_stream|cloudflarestream|videodelivery\.net|video is still preparing|media/i)) {
  classification = 'recorded_video_media_path_failure';
  requiredFixBucket = 'recorded_video_path';
} else if (hasAny(/postgres|postgre|pg_|connection slot|too many clients|deadlock|sqlstate|pool/i)) {
  classification = 'db_bottleneck';
  requiredFixBucket = 'db_redis_bottleneck';
} else if (hasAny(/redis|maxclients|readonly|noauth|bullmq|queue/i)) {
  classification = 'redis_bottleneck';
  requiredFixBucket = 'db_redis_bottleneck';
} else if (hasAny(/playwright|selector|browser|navigation timeout|target closed|page crashed|context/i)) {
  classification = 'browser_only_playback_issue';
  requiredFixBucket = 'recorded_video_path';
} else if (
  restartingContainers.length > 0
  || unhealthyContainers.length > 0
  || highCpuContainers.length > 0
  || highMemContainers.length > 0
  || badEndpoints.length > 0
) {
  classification = 'staging_host_exhaustion';
  requiredFixBucket = 'architecture_mismatch';
  rerunVerdict = 'resize_or_stabilize_environment_before_rerun';
}

if (
  classification === 'app_api_saturation'
  && (restartingContainers.length > 0 || unhealthyContainers.length > 0)
) {
  requiredFixBucket = 'host_runtime_hygiene';
}

const summary = {
  stageLabel,
  stageKind,
  classification,
  requiredFixBucket,
  rerunVerdict,
  signals: {
    restartingContainers,
    unhealthyContainers,
    highCpuContainers,
    highMemContainers,
    badEndpoints,
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
