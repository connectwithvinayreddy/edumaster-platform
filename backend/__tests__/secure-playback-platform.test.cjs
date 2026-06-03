const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSecurePlaybackClientContext,
  assertProtectedPlaybackPlatformAllowed,
  UNSUPPORTED_BROWSER_MESSAGE,
} = require('../lib/secure-playback.js');

const reqFor = (userAgent, headers = {}) => ({
  headers: {
    'user-agent': userAgent,
    'x-edumaster-device-id': 'secure-playback-platform-test-device',
    'x-edumaster-playback-tab-id': 'secure-playback-platform-test-tab',
    ...headers,
  },
  ip: '127.0.0.1',
});

const windowsChromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const windowsEdgeUa = `${windowsChromeUa} Edg/125.0.0.0`;
const windowsFirefoxUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';
const macSafariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const linuxChromeUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const androidChromeUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

const assertAllowed = (label, req) => {
  const context = buildSecurePlaybackClientContext(req);
  assert.equal(context.securePlaybackApproved, true, `${label} should be approved`);
  assert.doesNotThrow(() => assertProtectedPlaybackPlatformAllowed(context));
  return context;
};

const assertPlatformGateOpen = (label, req) => {
  const context = buildSecurePlaybackClientContext(req);
  assert.doesNotThrow(() => assertProtectedPlaybackPlatformAllowed(context), `${label} should pass the platform gate`);
  return context;
};

test('protected playback preserves browser detection metadata while allowing standard browsers', () => {
  const chrome = assertAllowed('Windows Chrome', reqFor(windowsChromeUa));
  assert.equal(chrome.platform, 'windows');
  assert.equal(chrome.browser, 'chrome');
  assert.equal(chrome.isChromeOnWindows, true);

  const edge = assertAllowed('Windows Edge', reqFor(windowsEdgeUa));
  assert.equal(edge.isEdgeOnWindows, true);

  const safari = assertAllowed('macOS Safari', reqFor(macSafariUa));
  assert.equal(safari.isSafariOnApple, true);

  const androidNative = assertAllowed('Android native app', reqFor(androidChromeUa, {
    'x-edumaster-app': 'android-app',
  }));
  assert.equal(androidNative.isAndroidNative, true);
});

test('protected playback platform gate remains open for desktop browsers', () => {
  const firefox = assertPlatformGateOpen('Windows Firefox', reqFor(windowsFirefoxUa));
  assert.equal(firefox.securePlaybackApproved, false);

  const linuxChrome = assertPlatformGateOpen('Linux Chrome', reqFor(linuxChromeUa));
  assert.equal(linuxChrome.securePlaybackApproved, false);

  const opera = assertPlatformGateOpen('Windows Opera', reqFor(windowsChromeUa, {
    'x-edumaster-client-browser': 'opera',
  }));
  assert.equal(opera.securePlaybackApproved, false);

  const brave = assertPlatformGateOpen('Windows Brave', reqFor(windowsChromeUa, {
    'x-edumaster-client-browser': 'brave',
  }));
  assert.equal(brave.securePlaybackApproved, false);
});

test('unsupported platform message stays generic and does not imply browser denial', () => {
  assert.doesNotMatch(UNSUPPORTED_BROWSER_MESSAGE, /Chrome, Firefox, Brave, Opera/);
  assert.doesNotMatch(UNSUPPORTED_BROWSER_MESSAGE, /not supported for protected paid video playback/);
});
