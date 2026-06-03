const crypto = require('crypto');

const UNSUPPORTED_BROWSER_MESSAGE = 'Protected playback is unavailable for this browser session. Please refresh, sign in again, or contact support if the issue continues.';

const normalizeHeader = (value) => String(value || '').trim().toLowerCase();

const buildUserAgentHash = (value) => crypto
  .createHash('sha256')
  .update(String(value || '').trim().toLowerCase())
  .digest('hex');

const detectBrowser = (userAgent, hintedBrowser = '') => {
  const hinted = normalizeHeader(hintedBrowser);
  if (hinted) {
    return hinted;
  }

  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'opera';
  if (ua.includes('brave')) return 'brave';
  if (ua.includes('firefox/') || ua.includes('fxios/')) return 'firefox';
  if (ua.includes('crios/') || ua.includes('chrome/')) return 'chrome';
  if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('crios/') && !ua.includes('android')) return 'safari';
  return 'unknown';
};

const detectPlatform = (userAgent, hintedPlatform = '') => {
  const hinted = normalizeHeader(hintedPlatform);
  if (hinted) {
    return hinted;
  }

  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod') || ua.includes('ios')) return 'ios';
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
};

const getReplicaId = () => String(
  process.env.REPLICA_NAME
  || process.env.HOSTNAME
  || process.env.SERVICE_NAME
  || `pid:${process.pid}`,
).trim();

const buildSecurePlaybackClientContext = (req) => {
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const deviceId = String(req.headers['x-edumaster-device-id'] || '').trim() || null;
  const playbackTabId = String(
    req.headers['x-edumaster-playback-tab-id']
    || req.headers['x-edumaster-browser-tab-id']
    || '',
  ).trim() || null;
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ipAddress = forwardedFor || String(req.ip || req.socket?.remoteAddress || '').trim() || null;
  const appMode = normalizeHeader(req.headers['x-edumaster-app'] || 'web');
  const platform = detectPlatform(userAgent, req.headers['x-edumaster-client-platform']);
  const browser = detectBrowser(userAgent, req.headers['x-edumaster-client-browser']);
  const browserFamily = browser;
  const isNativeApp = appMode === 'native' || appMode === 'android-app' || appMode === 'capacitor';
  const isAndroidNative = isNativeApp && platform === 'android';
  const isSafariOnApple = appMode === 'web' && browser === 'safari' && (platform === 'ios' || platform === 'macos');
  const isEdgeOnWindows = appMode === 'web' && browser === 'edge' && platform === 'windows';
  const isChromeOnWindows = appMode === 'web' && browser === 'chrome' && platform === 'windows';

  return {
    appMode,
    browser,
    browserFamily,
    deviceId,
    ipAddress,
    playbackTabId,
    platform,
    replica: getReplicaId(),
    requestId: String(req.requestId || req.headers['x-request-id'] || req.headers['cf-ray'] || '').trim() || null,
    userAgent,
    userAgentHash: buildUserAgentHash(userAgent),
    isNativeApp,
    isAndroidNative,
    isSafariOnApple,
    isEdgeOnWindows,
    isChromeOnWindows,
    securePlaybackApproved: isAndroidNative || isSafariOnApple || isEdgeOnWindows || isChromeOnWindows,
  };
};

const assertProtectedPlaybackPlatformAllowed = (context) => {
  return;
};

module.exports = {
  UNSUPPORTED_BROWSER_MESSAGE,
  buildSecurePlaybackClientContext,
  buildUserAgentHash,
  assertProtectedPlaybackPlatformAllowed,
};
