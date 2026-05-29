const path = require('path');
const { spawn } = require('child_process');

let replayImporterChild = null;

const isReplayImporterEnabled = () => String(process.env.LIVE_REPLAY_IMPORTER_AUTOSTART || '').trim().toLowerCase() === 'true';

const ensureReplayImporterWorker = () => {
  if (!isReplayImporterEnabled()) {
    return null;
  }

  if (replayImporterChild && !replayImporterChild.killed && replayImporterChild.exitCode === null) {
    return replayImporterChild;
  }

  const importerPath = path.join(__dirname, '../scripts/replay-importer.mjs');
  const child = spawn(process.execPath, [importerPath], {
    stdio: 'ignore',
    detached: false,
    env: process.env,
  });

  child.on('exit', () => {
    if (replayImporterChild === child) {
      replayImporterChild = null;
    }
  });

  child.on('error', (error) => {
    console.error('[live-replay-worker] replay importer failed to start', error);
    if (replayImporterChild === child) {
      replayImporterChild = null;
    }
  });

  replayImporterChild = child;
  return replayImporterChild;
};

module.exports = {
  ensureReplayImporterWorker,
};
