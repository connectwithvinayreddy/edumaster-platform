import path from 'node:path';
import { promises as fs } from 'node:fs';
import { importLiveRecording } from './import-live-recording.mjs';

const recordingsRoot = process.env.LIVE_RECORDINGS_ROOT || '/recordings';
const pollIntervalMs = Math.max(15_000, Number(process.env.REPLAY_IMPORT_POLL_MS || 60_000));
const minFileAgeSeconds = Math.max(5, Number(process.env.REPLAY_IMPORT_FILE_MIN_AGE_SECONDS || 120));

const supportedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.flv']);

const collectRecordingFiles = async (rootPath, currentPath, result) => {
  const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectRecordingFiles(rootPath, fullPath, result);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(fullPath).toLowerCase();
    if (!supportedExtensions.has(extension)) {
      continue;
    }

    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) {
      continue;
    }

    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds < minFileAgeSeconds) {
      continue;
    }

    const relativePath = path.relative(rootPath, fullPath);
    const relativeDirectory = path.dirname(relativePath);
    const normalizedDirectory = relativeDirectory.split(path.sep).join('/');
    const streamKey = normalizedDirectory === '.'
      ? path.basename(entry.name, extension)
      : normalizedDirectory;

    result.push({
      streamKey,
      filePath: fullPath,
      modifiedAt: stat.mtimeMs,
    });
  }
};

const listRecordingFiles = async (rootPath) => {
  const result = [];
  await collectRecordingFiles(rootPath, rootPath, result);
  return result.sort((left, right) => left.modifiedAt - right.modifiedAt);
};

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const main = async () => {
  for (;;) {
    const files = await listRecordingFiles(recordingsRoot);
    for (const file of files) {
      try {
        const result = await importLiveRecording({
          streamKey: file.streamKey,
          filePath: file.filePath,
        });
        process.stdout.write(`[replay-importer] imported ${result.filePath} -> ${result.replayLessonId}\n`);
      } catch (error) {
        process.stderr.write(`[replay-importer] failed for ${file.filePath}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    await sleep(pollIntervalMs);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
