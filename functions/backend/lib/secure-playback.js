const crypto = require('crypto');

const UNSUPPORTED_BROWSER_MESSAGE = 'For security reasons, protected course videos can be played only on the Android app, Safari on Apple devices, or Microsoft Edge on Windows. Chrome, Firefox, Brave, Opera, and other browsers are not supported for protected paid video playback. Please switch to an approved platform to continue watching.';

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

const buildSecurePlaybackClientContext = (req) => {
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const deviceId = String(req.headers['x-edumaster-device-id'] || '').trim() || null;
  const appMode = normalizeHeader(req.headers['x-edumaster-app'] || 'web');
  const platform = detectPlatform(userAgent, req.headers['x-edumaster-client-platform']);
  const browser = detectBrowser(userAgent, req.headers['x-edumaster-client-browser']);
  const browserFamily = browser;
  const isNativeApp = appMode === 'native' || appMode === 'android-app' || appMode === 'capacitor';
  const isAndroidNative = isNativeApp && platform === 'android';
  const isSafariOnApple = appMode === 'web' && browser === 'safari' && (platform === 'ios' || platform === 'macos');
  const isEdgeOnWindows = appMode === 'web' && browser === 'edge' && platform === 'windows';

  return {
    appMode,
    browser,
    browserFamily,
    deviceId,
    platform,
    userAgent,
    userAgentHash: buildUserAgentHash(userAgent),
    isNativeApp,
    isAndroidNative,
    isSafariOnApple,
    isEdgeOnWindows,
    securePlaybackApproved: isAndroidNative || isSafariOnApple || isEdgeOnWindows,
  };
};

const assertProtectedPlaybackPlatformAllowed = (context) => {
  if (context?.securePlaybackApproved) {
    return;
  }

  const error = new Error(UNSUPPORTED_BROWSER_MESSAGE);
  error.statusCode = 403;
  error.code = 'PROTECTED_PLAYBACK_PLATFORM_UNSUPPORTED';
  throw error;
};

module.exports = {
  UNSUPPORTED_BROWSER_MESSAGE,
  buildSecurePlaybackClientContext,
  buildUserAgentHash,
  assertProtectedPlaybackPlatformAllowed,
};
