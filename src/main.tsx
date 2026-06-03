import React, { Component, ErrorInfo, ReactNode, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { AlertCircle, RefreshCcw } from 'lucide-react';
import App from './App.tsx';
import { PublicLegalPage } from './components/PublicLegalPage.tsx';
import { PublicLandingPage } from './components/PublicLandingPage.tsx';
import { AuthProvider, useAuth } from './AuthContext.tsx';
import { EduService } from './EduService.ts';
import { applySeoForHostname, isMarketingHostname } from './lib/siteExperience.ts';
import './index.css';

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('cap-native', `cap-${Capacitor.getPlatform()}`);
}

const APP_ENTRY_SCRIPT_PATH = (() => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return '';
  }

  const script = document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null;
  if (script?.src) {
    return new URL(script.src, window.location.href).pathname;
  }

  try {
    return new URL(import.meta.url, window.location.href).pathname;
  } catch {
    return '';
  }
})();

const extractLatestEntryScriptPath = (html: string) => {
  const match = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
  if (!match?.[1]) {
    return '';
  }

  try {
    return new URL(match[1], window.location.origin).pathname;
  } catch {
    return '';
  }
};

const CHUNK_LOAD_ERROR_PATTERN = /(?:failed to fetch dynamically imported module|importing a module script failed|loading chunk [\w/-]+ failed|module script|unable to preload css)/i;

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message || error.name || 'Unknown error';
  }
  return String(error || 'Unknown error');
};

const isChunkLoadFailure = (error: unknown) => CHUNK_LOAD_ERROR_PATTERN.test(getErrorMessage(error));

const getChunkRecoveryKey = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  const routeKey = `${window.location.pathname}${window.location.search}`;
  const entryKey = APP_ENTRY_SCRIPT_PATH || 'unknown-entry';
  return `edumaster:chunk-recovery:${entryKey}:${routeKey}`;
};

const attemptChunkLoadRecovery = (error: unknown) => {
  if (typeof window === 'undefined' || !isChunkLoadFailure(error)) {
    return false;
  }

  try {
    const recoveryKey = getChunkRecoveryKey();
    if (recoveryKey && window.sessionStorage.getItem(recoveryKey) === '1') {
      return false;
    }
    if (recoveryKey) {
      window.sessionStorage.setItem(recoveryKey, '1');
    }
  } catch {
    // Keep recovery best-effort when sessionStorage is unavailable.
  }

  window.setTimeout(() => {
    window.location.reload();
  }, 60);
  return true;
};

type BootTelemetryEvent = {
  name: string;
  at: string;
  elapsedMs: number;
  payload?: Record<string, unknown>;
};

type BootTelemetryStore = {
  startedAtEpochMs: number;
  startedAtIso: string;
  registered: boolean;
  shellReady: boolean;
  lastRouteMarker: string | null;
  events: BootTelemetryEvent[];
};

type BootWindow = Window & {
  __edumasterBootTelemetry?: BootTelemetryStore;
};

const APP_BOOT_TIMEOUT_MS = 20_000;
const MAX_BOOT_EVENTS = 200;
const ROUTE_BOOT_MARKERS = [
  { name: 'shell-ready', selector: '[data-testid="shell-ready"]' },
  { name: 'overview-dashboard', selector: '[data-testid="overview-dashboard"]' },
  { name: 'course-page', selector: '[data-testid="course-figma-page"]' },
  { name: 'course-player', selector: '[data-testid="course-player-fullscreen"], [data-testid="course-player-video"]' },
  { name: 'analytics-page', selector: '[data-testid="analytics-page"]' },
  { name: 'admin-page', selector: '[data-testid^="admin-"][data-testid$="-loaded"]' },
] as const;

const getBootTelemetryStore = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const bootWindow = window as BootWindow;
  if (!bootWindow.__edumasterBootTelemetry) {
    bootWindow.__edumasterBootTelemetry = {
      startedAtEpochMs: Date.now(),
      startedAtIso: new Date().toISOString(),
      registered: false,
      shellReady: false,
      lastRouteMarker: null,
      events: [],
    };
  }

  return bootWindow.__edumasterBootTelemetry;
};

const emitBootTelemetry = (name: string, payload?: Record<string, unknown>) => {
  const store = getBootTelemetryStore();
  if (!store || typeof window === 'undefined') {
    return;
  }

  const event: BootTelemetryEvent = {
    name,
    at: new Date().toISOString(),
    elapsedMs: Math.max(Date.now() - store.startedAtEpochMs, 0),
    payload,
  };
  store.events.push(event);
  if (store.events.length > MAX_BOOT_EVENTS) {
    store.events.splice(0, store.events.length - MAX_BOOT_EVENTS);
  }

  console.info('[app-boot]', name, payload || {});
  window.dispatchEvent(new CustomEvent('edumaster:app-boot', { detail: event }));
};

const startAppBootTelemetry = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const store = getBootTelemetryStore();
  if (!store || store.registered) {
    return;
  }
  store.registered = true;

  let emptyRootTimer = 0;

  const markShellReady = () => {
    if (store.shellReady || !document.querySelector('[data-testid="shell-ready"]')) {
      return;
    }

    store.shellReady = true;
    if (emptyRootTimer) {
      window.clearTimeout(emptyRootTimer);
      emptyRootTimer = 0;
    }
    emitBootTelemetry('shell_ready', {
      url: window.location.href,
      title: document.title || '',
      readyState: document.readyState,
    });
  };

  const markRouteVisible = () => {
    const matchedMarker = ROUTE_BOOT_MARKERS.find((marker) => document.querySelector(marker.selector));
    if (!matchedMarker || matchedMarker.name === store.lastRouteMarker) {
      return;
    }

    store.lastRouteMarker = matchedMarker.name;
    emitBootTelemetry('route_visible', {
      marker: matchedMarker.name,
      selector: matchedMarker.selector,
      url: window.location.href,
      readyState: document.readyState,
    });
  };

  const handleRuntimeError = (event: ErrorEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLScriptElement
      || target instanceof HTMLLinkElement
      || target instanceof HTMLImageElement
    ) {
      return;
    }

    emitBootTelemetry('runtime_error', {
      message: event.message || 'Unknown error',
      source: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      shellReady: store.shellReady,
      lastRouteMarker: store.lastRouteMarker,
    });
  };

  const handleAssetError = (event: Event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLScriptElement)
      && !(target instanceof HTMLLinkElement)
      && !(target instanceof HTMLImageElement)
    ) {
      return;
    }

    const url = target instanceof HTMLLinkElement
      ? target.href
      : target instanceof HTMLScriptElement
        ? target.src
        : target.currentSrc || target.getAttribute('src') || '';

    emitBootTelemetry('asset_load_failure', {
      tagName: target.tagName.toLowerCase(),
      url: url || null,
      shellReady: store.shellReady,
      lastRouteMarker: store.lastRouteMarker,
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason instanceof Error
      ? event.reason.message
      : String(event.reason || 'Unknown rejection');
    const chunkRecoveryTriggered = attemptChunkLoadRecovery(event.reason);
    emitBootTelemetry('unhandled_rejection', {
      reason,
      chunkRecoveryTriggered,
      shellReady: store.shellReady,
      lastRouteMarker: store.lastRouteMarker,
    });
  };

  const observer = new MutationObserver(() => {
    markShellReady();
    markRouteVisible();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid', 'class'],
  });

  document.addEventListener('readystatechange', () => {
    emitBootTelemetry('ready_state_change', {
      readyState: document.readyState,
    });
  });
  document.addEventListener('DOMContentLoaded', () => {
    emitBootTelemetry('dom_content_loaded', {
      readyState: document.readyState,
    });
  }, { once: true });
  window.addEventListener('load', () => {
    emitBootTelemetry('window_load', {
      readyState: document.readyState,
    });
  }, { once: true });
  window.addEventListener('error', handleRuntimeError);
  window.addEventListener('error', handleAssetError, true);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  emptyRootTimer = window.setTimeout(() => {
    if (store.shellReady) {
      return;
    }

    const root = document.getElementById('root');
    emitBootTelemetry('empty_root_timeout', {
      url: window.location.href,
      title: document.title || '',
      readyState: document.readyState,
      rootChildCount: root?.childElementCount || 0,
      rootTextLength: root?.textContent?.trim().length || 0,
      bodyTextLength: document.body?.innerText?.trim().length || 0,
      lastRouteMarker: store.lastRouteMarker,
    });
  }, APP_BOOT_TIMEOUT_MS);

  emitBootTelemetry('boot_start', {
    url: window.location.href,
    path: window.location.pathname,
    search: window.location.search,
    entryScriptPath: APP_ENTRY_SCRIPT_PATH || null,
  });
  markShellReady();
  markRouteVisible();
};

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  recoveringFromChunkFailure: boolean;
}

type ProtectionReason = 'idle' | 'background' | 'capture' | 'screenshot' | 'native';

type ProtectionEventDetail = {
  protected?: boolean;
  reason?: ProtectionReason;
};

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    recoveringFromChunkFailure: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, recoveringFromChunkFailure: false };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (attemptChunkLoadRecovery(error)) {
      console.warn('Detected stale lazy chunk; reloading application once.', {
        message: error.message,
      });
      this.setState({
        hasError: true,
        error,
        recoveringFromChunkFailure: true,
      });
      return;
    }

    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.state.recoveringFromChunkFailure) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-blue-100 p-8 text-center">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <RefreshCcw className="w-8 h-8 text-blue-600 animate-spin" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Refreshing application</h2>
              <p className="text-gray-500">A new version was detected. Reloading now to recover the current session.</p>
            </div>
          </div>
        );
      }

      let errorMessage = "An unexpected error occurred.";
      let isFirestoreError = false;

      try {
        if (this.state.error?.message) {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && parsed.operationType) {
            errorMessage = `Database Error: ${parsed.error} during ${parsed.operationType} on ${parsed.path}`;
            isFirestoreError = true;
          }
        }
      } catch (e) {
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-red-100 p-8 text-center">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8 text-red-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h2>
            <p className="text-gray-500 mb-8">{errorMessage}</p>
            
            <div className="space-y-3">
              <button
                onClick={() => window.location.reload()}
                className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
              >
                <RefreshCcw className="w-4 h-4" /> Reload Application
              </button>
              {isFirestoreError && (
                <p className="text-xs text-gray-400">
                  This might be due to missing permissions. Please contact support if the issue persists.
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const pauseAllMedia = () => {
  document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((element) => {
    try {
      element.pause();
    } catch (error) {
      console.warn('Unable to pause media during content protection', error);
    }
  });
};

const SCREENSHOT_SHORTCUT_RELEASE_MS = 1800;
const browserContentProtectionEnabled = String(import.meta.env.VITE_ENABLE_BROWSER_CONTENT_PROTECTION || 'false')
  .trim()
  .toLowerCase() === 'true';

const isEditableElement = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [data-allow-selection="true"], [data-allow-copy="true"]'));
};

const isScreenshotShortcut = (event: KeyboardEvent) => {
  if (event.key === 'PrintScreen') {
    return true;
  }

  const key = event.key.toLowerCase();
  const isMacCaptureChord = event.metaKey && event.shiftKey && ['3', '4', '5'].includes(key);
  const isWindowsSnipChord = event.metaKey && event.shiftKey && key === 's';

  return isMacCaptureChord || isWindowsSnipChord;
};

const isDesktopDevtoolsHeuristicSafe = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (Capacitor.isNativePlatform()) {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
  const hoverNone = typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: none)').matches
    : false;
  const narrowViewport = window.innerWidth <= 900;

  return !coarsePointer && !hoverNone && !narrowViewport;
};

const shouldBypassBrowserContentProtection = () => {
  if (!browserContentProtectionEnabled) {
    return true;
  }

  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('qaDisableContentProtection') === '1'
      || window.localStorage.getItem('edumaster.qa.disableContentProtection') === 'true';
  } catch {
    return false;
  }
};

const ContentProtectionShell = () => {
  const bypassProtection = shouldBypassBrowserContentProtection();
  const [nativeProtected, setNativeProtected] = useState(false);
  const [browserProtected, setBrowserProtected] = useState(false);
  const [reason, setReason] = useState<ProtectionReason>('idle');
  const nativeProtectedRef = useRef(false);
  const browserProtectionTimeoutRef = useRef<number | null>(null);
  const devToolsSuspectedRef = useRef(false);

  useEffect(() => {
    nativeProtectedRef.current = nativeProtected;
  }, [nativeProtected]);

  useEffect(() => {
    if (bypassProtection) {
      return undefined;
    }
    document.documentElement.classList.add('content-protection-enabled');
    return () => {
      document.documentElement.classList.remove('content-protection-enabled');
    };
  }, [bypassProtection]);

  useEffect(() => {
    if (bypassProtection) {
      return undefined;
    }
    const root = document.documentElement;
    const body = document.body;
    const protectedActive = nativeProtected || browserProtected;

    root.classList.toggle('app-protected-active', protectedActive);
    body.classList.toggle('app-protected-active', protectedActive);

    return () => {
      root.classList.remove('app-protected-active');
      body.classList.remove('app-protected-active');
    };
  }, [browserProtected, bypassProtection, nativeProtected]);

  useEffect(() => {
    if (bypassProtection) {
      return undefined;
    }
    const clearBrowserProtectionTimeout = () => {
      if (browserProtectionTimeoutRef.current !== null) {
        window.clearTimeout(browserProtectionTimeoutRef.current);
        browserProtectionTimeoutRef.current = null;
      }
    };

    const scheduleScreenshotProtectionRelease = () => {
      clearBrowserProtectionTimeout();
      browserProtectionTimeoutRef.current = window.setTimeout(() => {
        browserProtectionTimeoutRef.current = null;
        if (!document.hidden && !nativeProtectedRef.current) {
          setBrowserProtected(false);
          setReason('idle');
        }
      }, SCREENSHOT_SHORTCUT_RELEASE_MS);
    };

    const handleProtectionEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProtectionEventDetail>).detail || {};
      const nextProtected = Boolean(detail.protected);
      const nextReason = detail.reason || 'native';

      setNativeProtected(nextProtected);
      setReason(nextProtected ? nextReason : 'idle');

      if (nextProtected) {
        pauseAllMedia();
        void EduService.trackSuspiciousProtectedContentEvent({
          eventName: nextReason,
          source: 'native-content-protection',
        }).catch(() => undefined);
      }
    };

    const handleVisibilityChange = () => {
      const shouldProtect = document.hidden;
      setBrowserProtected(shouldProtect);
      if (shouldProtect) {
        setReason('background');
        pauseAllMedia();
        clearBrowserProtectionTimeout();
        void EduService.trackSuspiciousProtectedContentEvent({
          eventName: 'tab-backgrounded',
        }).catch(() => undefined);
      }
    };

    const handleWindowBlur = () => {
      setBrowserProtected(true);
      setReason('background');
      pauseAllMedia();
      clearBrowserProtectionTimeout();
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName: 'window-blur',
      }).catch(() => undefined);
    };

    const handleWindowFocus = () => {
      if (!document.hidden) {
        setBrowserProtected(false);
        if (!nativeProtectedRef.current) {
          setReason('idle');
        }
      }
    };

    const handleScreenshotShortcut = (event: KeyboardEvent) => {
      if (!isScreenshotShortcut(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setBrowserProtected(true);
      setReason('screenshot');
      pauseAllMedia();
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName: 'screenshot-shortcut',
      }).catch(() => undefined);
      scheduleScreenshotProtectionRelease();
    };

    const preventNonEditableSelection = (event: Event) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName: event.type === 'dragstart' ? 'drag-selection' : 'text-selection',
      }).catch(() => undefined);
    };

    const handleClipboardEvent = (event: ClipboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName: event.type === 'cut' ? 'cut-shortcut' : 'copy-shortcut',
      }).catch(() => undefined);
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName: 'context-menu',
      }).catch(() => undefined);
    };

    const handleRestrictedShortcut = (event: KeyboardEvent) => {
      const key = String(event.key || '').toLowerCase();
      const modifierPressed = event.metaKey || event.ctrlKey;
      const isCopyCutShortcut = modifierPressed && ['c', 'x', 'a'].includes(key);
      const isSaveShortcut = modifierPressed && key === 's';
      const isPrintShortcut = modifierPressed && key === 'p';
      const isViewSourceShortcut = modifierPressed && key === 'u';
      const isDevToolsShortcut = event.key === 'F12'
        || (modifierPressed && event.shiftKey && ['i', 'j', 'c'].includes(key));

      if (
        (!isCopyCutShortcut && !isSaveShortcut && !isPrintShortcut && !isViewSourceShortcut && !isDevToolsShortcut)
        || isEditableElement(event.target)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const eventName = isDevToolsShortcut
        ? 'devtools-shortcut'
        : isPrintShortcut
          ? 'print-shortcut'
          : isViewSourceShortcut
            ? 'view-source-shortcut'
            : isSaveShortcut
              ? 'save-shortcut'
              : 'copy-shortcut';
      void EduService.trackSuspiciousProtectedContentEvent({
        eventName,
      }).catch(() => undefined);
    };

    const inspectDevTools = () => {
      if (!isDesktopDevtoolsHeuristicSafe()) {
        if (devToolsSuspectedRef.current && !document.hidden && !nativeProtectedRef.current) {
          setBrowserProtected(false);
          setReason('idle');
        }
        devToolsSuspectedRef.current = false;
        return;
      }

      const widthGap = Math.abs(window.outerWidth - window.innerWidth);
      const heightGap = Math.abs(window.outerHeight - window.innerHeight);
      const suspected = widthGap > 160 || heightGap > 160;
      if (suspected) {
        setBrowserProtected(true);
        setReason('capture');
        pauseAllMedia();
        if (!devToolsSuspectedRef.current) {
          void EduService.trackSuspiciousProtectedContentEvent({
            eventName: 'devtools-suspected',
          }).catch(() => undefined);
        }
      } else if (devToolsSuspectedRef.current && !document.hidden && !nativeProtectedRef.current) {
        setBrowserProtected(false);
        setReason('idle');
      }
      devToolsSuspectedRef.current = suspected;
    };

    window.addEventListener('app-content-protection', handleProtectionEvent as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('copy', handleClipboardEvent);
    document.addEventListener('cut', handleClipboardEvent);
    document.addEventListener('selectstart', preventNonEditableSelection);
    document.addEventListener('dragstart', preventNonEditableSelection);
    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('keydown', handleScreenshotShortcut, true);
    window.addEventListener('keydown', handleRestrictedShortcut, true);
    inspectDevTools();
    const devToolsIntervalId = window.setInterval(inspectDevTools, 1500);

    return () => {
      window.removeEventListener('app-content-protection', handleProtectionEvent as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('copy', handleClipboardEvent);
      document.removeEventListener('cut', handleClipboardEvent);
      document.removeEventListener('selectstart', preventNonEditableSelection);
      document.removeEventListener('dragstart', preventNonEditableSelection);
      document.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('keydown', handleScreenshotShortcut, true);
      window.removeEventListener('keydown', handleRestrictedShortcut, true);
      window.clearInterval(devToolsIntervalId);
      clearBrowserProtectionTimeout();
    };
  }, [bypassProtection]);

  if (bypassProtection) {
    return <App />;
  }

  const isProtected = nativeProtected || browserProtected;
  const message = reason === 'capture' || reason === 'native'
    ? 'Screen recording is not allowed'
    : reason === 'screenshot'
      ? 'Screenshots are not allowed'
      : 'Protected content';

  return (
    <>
      <App />
      {isProtected && typeof document !== 'undefined'
        ? createPortal(
          <div className="app-content-protection-overlay" aria-live="assertive" role="alert">
            <div className="app-content-protection-message">{message}</div>
            <div className="app-content-protection-subtitle">This screen cannot be captured or shared.</div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
};

const APP_VERSION_CHECK_INTERVAL_MS = 60_000;

const AppVersionGuard = () => {
  useEffect(() => {
    if (import.meta.env.DEV || typeof window === 'undefined' || typeof document === 'undefined' || !APP_ENTRY_SCRIPT_PATH) {
      return undefined;
    }

    let stopped = false;
    let inFlight = false;

    const checkForUpdatedBundle = async () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response = await fetch(`${window.location.origin}/`, {
          cache: 'no-store',
          headers: {
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          },
        });
        const html = await response.text();
        const latestScriptPath = extractLatestEntryScriptPath(html);
        if (latestScriptPath && latestScriptPath !== APP_ENTRY_SCRIPT_PATH) {
          console.warn('[app-version-guard] Reloading stale client bundle', {
            current: APP_ENTRY_SCRIPT_PATH,
            latest: latestScriptPath,
          });
          window.location.reload();
        }
      } catch (error) {
        console.warn('[app-version-guard] Unable to verify latest bundle', error);
      } finally {
        inFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkForUpdatedBundle();
      }
    };

    const handleFocus = () => {
      void checkForUpdatedBundle();
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkForUpdatedBundle();
      }
    }, APP_VERSION_CHECK_INTERVAL_MS);

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void checkForUpdatedBundle();

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return null;
};

const HostRoutedExperience = () => {
  useEffect(() => {
    applySeoForHostname(window.location.hostname);
  }, []);

  const marketingHost = !Capacitor.isNativePlatform() && isMarketingHostname(window.location.hostname);
  if (marketingHost) {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/privacy-policy') {
      return (
        <PublicLegalPage
          title="Privacy Policy"
          intro="This Privacy Policy explains how VaronEnglish handles learner information when students use the VaronEnglish website and mobile application."
          sections={[
            {
              heading: 'Information we collect',
              body: [
                'VaronEnglish may collect account details such as name, email address, phone number, and login identifiers when users register or sign in.',
                'The platform may also collect learning activity data such as enrolled courses, progress, assessment attempts, and device/session details needed to keep the service secure and functional.',
              ],
            },
            {
              heading: 'How we use information',
              body: [
                'We use collected information to provide access to courses, mock tests, revision materials, payments, and progress tracking features.',
                'We may also use the information to improve platform performance, resolve support issues, prevent misuse, and maintain account security.',
              ],
            },
            {
              heading: 'Sharing and storage',
              body: [
                'VaronEnglish does not sell personal information. Data may be processed by infrastructure, hosting, payment, authentication, and analytics providers only as needed to operate the service.',
                'Information is stored and retained for legitimate educational, operational, security, and legal purposes.',
              ],
            },
            {
              heading: 'User choices',
              body: [
                'Users can contact the VaronEnglish support team to request account assistance, updates, or deletion requests subject to legal and operational obligations.',
                'If this policy changes materially, the updated version will be published on this page.',
              ],
            },
          ]}
        />
      );
    }

    if (pathname === '/terms-and-conditions' || pathname === '/terms') {
      return (
        <PublicLegalPage
          title="Terms and Conditions"
          intro="These Terms and Conditions govern access to the VaronEnglish website, app, courses, mock tests, and related services."
          sections={[
            {
              heading: 'Use of the platform',
              body: [
                'Users may access VaronEnglish only for lawful educational purposes and must not misuse the platform, interfere with operations, or attempt unauthorized access.',
                'Accounts are personal to the registered learner and may not be shared in violation of platform rules.',
              ],
            },
            {
              heading: 'Content and access',
              body: [
                'Course videos, tests, notes, branding, and related materials remain the property of VaronEnglish or its licensors.',
                'Access duration, entitlements, and features may depend on the learner plan or purchase selected.',
              ],
            },
            {
              heading: 'Payments and conduct',
              body: [
                'Paid purchases, refunds, and promotional access are subject to the terms communicated at the time of purchase and any applicable law.',
                'VaronEnglish may suspend or restrict accounts involved in abuse, fraud, or policy violations.',
              ],
            },
            {
              heading: 'Changes and support',
              body: [
                'VaronEnglish may update features, content, pricing, or policies over time. Continued use after changes means the user accepts the revised terms.',
                'For support or policy questions, learners should contact the official VaronEnglish support channel listed in the app or website.',
              ],
            },
          ]}
        />
      );
    }

    if (pathname === '/account-deletion') {
      return (
        <PublicLegalPage
          title="Account Deletion Request"
          intro="VaronEnglish users can request deletion of their account and associated personal data through the support process described on this page."
          sections={[
            {
              heading: 'How to request deletion',
              body: [
                'Send an email from your registered account email address to support@varonenglishapp.in with the subject line Account Deletion Request.',
                'In the email, include your full name, registered email address, and if available your mobile number used in the VaronEnglish account.',
              ],
            },
            {
              heading: 'What happens next',
              body: [
                'The VaronEnglish support team will verify the request and begin account deletion processing.',
                'Account access, learner profile data, and associated personal data that is not required for legal, fraud-prevention, billing, security, or record-keeping purposes will be deleted or anonymized as applicable.',
              ],
            },
            {
              heading: 'Retention exceptions',
              body: [
                'Certain records may be retained for a limited period where required for legal compliance, payment reconciliation, fraud prevention, abuse prevention, or legitimate security and audit needs.',
                'After retention obligations expire, the remaining retained personal data will be deleted or anonymized in accordance with operational policy.',
              ],
            },
          ]}
        />
      );
    }

    return <PublicLandingPage />;
  }

  return (
    <AuthProvider>
      <AppVersionGuard />
      <ContentProtectionShell />
    </AuthProvider>
  );
};

startAppBootTelemetry();
emitBootTelemetry('root_render_requested', {
  entryScriptPath: APP_ENTRY_SCRIPT_PATH || null,
});

const appTree = (
  <ErrorBoundary>
    <HostRoutedExperience />
  </ErrorBoundary>
);

createRoot(document.getElementById('root')!).render(
  import.meta.env.DEV ? appTree : <StrictMode>{appTree}</StrictMode>,
);
