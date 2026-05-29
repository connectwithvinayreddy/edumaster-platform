import React, { Component, ErrorInfo, ReactNode, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { AlertCircle, RefreshCcw } from 'lucide-react';
import App from './App.tsx';
import { AuthProvider, useAuth } from './AuthContext.tsx';
import './index.css';

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('cap-native', `cap-${Capacitor.getPlatform()}`);
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

type ProtectionReason = 'idle' | 'background' | 'capture' | 'screenshot' | 'native';

type ProtectionEventDetail = {
  protected?: boolean;
  reason?: ProtectionReason;
};

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
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

const ContentProtectionShell = () => {
  const [nativeProtected, setNativeProtected] = useState(false);
  const [browserProtected, setBrowserProtected] = useState(false);
  const [reason, setReason] = useState<ProtectionReason>('idle');
  const nativeProtectedRef = useRef(false);
  const browserProtectionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    nativeProtectedRef.current = nativeProtected;
  }, [nativeProtected]);

  useEffect(() => {
    document.documentElement.classList.add('content-protection-enabled');
    return () => {
      document.documentElement.classList.remove('content-protection-enabled');
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const protectedActive = nativeProtected || browserProtected;

    root.classList.toggle('app-protected-active', protectedActive);
    body.classList.toggle('app-protected-active', protectedActive);

    return () => {
      root.classList.remove('app-protected-active');
      body.classList.remove('app-protected-active');
    };
  }, [nativeProtected, browserProtected]);

  useEffect(() => {
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
      }
    };

    const handleVisibilityChange = () => {
      const shouldProtect = document.hidden;
      setBrowserProtected(shouldProtect);
      if (shouldProtect) {
        setReason('background');
        pauseAllMedia();
        clearBrowserProtectionTimeout();
      }
    };

    const handleWindowBlur = () => {
      setBrowserProtected(true);
      setReason('background');
      pauseAllMedia();
      clearBrowserProtectionTimeout();
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
      scheduleScreenshotProtectionRelease();
    };

    const preventNonEditableSelection = (event: Event) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    const handleClipboardEvent = (event: ClipboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    const handleRestrictedShortcut = (event: KeyboardEvent) => {
      const key = String(event.key || '').toLowerCase();
      const modifierPressed = event.metaKey || event.ctrlKey;
      const isCopyCutShortcut = modifierPressed && ['c', 'x', 'a'].includes(key);
      const isSaveShortcut = modifierPressed && key === 's';

      if ((!isCopyCutShortcut && !isSaveShortcut) || isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
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
      clearBrowserProtectionTimeout();
    };
  }, []);

  const isProtected = nativeProtected || browserProtected;
  const message = reason === 'capture' || reason === 'native'
    ? 'Screen recording is not allowed'
    : reason === 'screenshot'
      ? 'Screenshots are not allowed'
      : 'Protected content';

  return (
    <>
      <App />
      {isProtected ? (
        <div className="app-content-protection-overlay" aria-live="assertive" role="alert">
          <div className="app-content-protection-message">{message}</div>
          <div className="app-content-protection-subtitle">This screen cannot be captured or shared.</div>
        </div>
      ) : null}
    </>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <ContentProtectionShell />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
