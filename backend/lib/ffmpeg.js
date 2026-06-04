const { spawnSync } = require('child_process');
const ffmpegStaticPath = require('ffmpeg-static');

const normalizeCandidate = (value) => {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
};

const canExecuteBinary = (candidate, args = ['-version']) => {
  if (!candidate) {
    return false;
  }

  try {
    const result = spawnSync(candidate, args, {
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
    if (canExecuteBinary(candidate, ['-version'])) {
      return candidate;
    }
  }

  return null;
};

const resolveFfprobePath = () => {
  const staticCandidate = ffmpegStaticPath
    ? normalizeCandidate(ffmpegStaticPath.replace(/ffmpeg(?:(?:\.exe)?)$/i, (match) => match.toLowerCase().includes('.exe') ? 'ffprobe.exe' : 'ffprobe'))
    : null;

  const candidates = [
    normalizeCandidate(process.env.FFPROBE_PATH),
    'ffprobe',
    staticCandidate,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (canExecuteBinary(candidate, ['-version'])) {
      return candidate;
    }
  }

  return null;
};

module.exports = {
  resolveFfmpegPath,
  resolveFfprobePath,
};
