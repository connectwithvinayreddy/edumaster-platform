const { spawnSync } = require('child_process');
const ffmpegStaticPath = require('ffmpeg-static');

const normalizeCandidate = (value) => {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
};

const canExecuteFfmpeg = (candidate) => {
  if (!candidate) {
    return false;
  }

  try {
    const result = spawnSync(candidate, ['-version'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return result.status === 0 && !result.error;
  } catch (_error) {
    return false;
  }
};

const resolveFfmpegPath = () => {
  const candidates = [
    normalizeCandidate(process.env.FFMPEG_PATH),
    'ffmpeg',
    normalizeCandidate(ffmpegStaticPath),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (canExecuteFfmpeg(candidate)) {
      return candidate;
    }
  }

  return null;
};

module.exports = {
  resolveFfmpegPath,
};
