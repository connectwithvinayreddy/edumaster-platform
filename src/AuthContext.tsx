import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  ActionCodeSettings,
  EmailAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile as updateFirebaseProfile,
} from 'firebase/auth';
import type { FirebaseError } from 'firebase/app';
import { EduService } from './EduService';
import { auth as firebaseAuth } from './firebase';
import { AuthResponse, AuthUser, RegisterPayload } from './types';

const AUTH_EVENT_KEY = 'edumaster.auth.event';
const AUTH_SESSION_META_KEY = 'edumaster.auth.session';
const getPasswordResetActionSettings = (): ActionCodeSettings => {
  const fallbackUrl = 'https://app.varonenglishapp.in/';
  const appUrl = typeof window !== 'undefined'
    ? String(window.location.origin || '').trim() || fallbackUrl
    : fallbackUrl;

  return {
    url: appUrl,
    handleCodeInApp: false,
  };
};

const isFirebasePasswordFallbackError = (error: unknown) => {
  const code = String((error as FirebaseError | undefined)?.code || '').trim();
  return [
    'auth/invalid-credential',
    'auth/user-not-found',
    'auth/wrong-password',
    'auth/invalid-login-credentials',
    'auth/too-many-requests',
  ].includes(code);
};

type WindowWithProgressFlush = Window & {
  __edumasterFlushProgress?: () => Promise<void>;
};

type AuthEventPayload = {
  type?: 'login' | 'logout';
  userId?: string | null;
  sessionId?: string | null;
  issuedAt?: string | null;
};

const readAuthSessionMeta = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_META_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { userId?: unknown; sessionId?: unknown };
    return {
      userId: parsed.userId ? String(parsed.userId) : null,
      sessionId: parsed.sessionId ? String(parsed.sessionId) : null,
    };
  } catch {
    return null;
  }
};

const shouldAcceptCrossTabLogout = (payload: AuthEventPayload, activeUser: AuthUser | null) => {
  const meta = readAuthSessionMeta();
  const currentUserId = activeUser?._id || meta?.userId || null;
  const currentSessionId = activeUser?.session || meta?.sessionId || null;
  const eventUserId = payload.userId ? String(payload.userId) : null;
  const eventSessionId = payload.sessionId ? String(payload.sessionId) : null;

  if (!eventUserId && !eventSessionId) {
    return true;
  }

  if (eventUserId && currentUserId && eventUserId !== currentUserId) {
    return false;
  }

  if (eventSessionId && currentSessionId && eventSessionId !== currentSessionId) {
    return false;
  }

  return true;
};

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  login: (
    identifier: string,
    password: string,
    options?: { forceLogoutOtherSessions?: boolean; rememberMe?: boolean },
  ) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updateProfile: (payload: { name: string; mobileNumber?: string | null }) => Promise<void>;
  changePassword: (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  isAdmin: false,
  login: async () => {},
  register: async () => {},
  requestPasswordReset: async () => {},
  updateProfile: async () => {},
  changePassword: async () => {},
  logout: async () => {},
  refreshSession: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = async () => {
    const sessionUser = await EduService.restoreSession();
    setUser(sessionUser);
  };

  useEffect(() => {
    refreshSession().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleAuthExpired = (event: Event) => {
      const detail = (event as CustomEvent<AuthEventPayload>).detail || {};
      if (!shouldAcceptCrossTabLogout(detail, user)) {
        console.warn('[auth-expired-ignored]', detail);
        return;
      }
      setUser(null);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_EVENT_KEY || !event.newValue) {
        return;
      }

      try {
        const payload = JSON.parse(event.newValue) as AuthEventPayload;
        if (payload.type === 'logout') {
          if (!shouldAcceptCrossTabLogout(payload, user)) {
            console.warn('[auth-storage-logout-ignored]', payload);
            return;
          }
          setUser(null);
          return;
        }

        if (payload.type === 'login') {
          void refreshSession();
        }
      } catch {
        // Ignore malformed cross-tab auth events.
      }
    };

    window.addEventListener('edumaster:auth-expired', handleAuthExpired);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('edumaster:auth-expired', handleAuthExpired);
      window.removeEventListener('storage', handleStorage);
    };
  }, [user]);

  const login = async (
    identifier: string,
    password: string,
    options?: { forceLogoutOtherSessions?: boolean; rememberMe?: boolean },
  ) => {
    await applyPersistence(options?.rememberMe ?? true);
    let response: AuthResponse;

    try {
      const credential = await signInWithEmailAndPassword(firebaseAuth, String(identifier || '').trim(), password);
      const idToken = await credential.user.getIdToken(true);
      response = await EduService.firebaseLogin('password', idToken, {
        forceLogoutOtherSessions: options?.forceLogoutOtherSessions,
      });
    } catch (error) {
      if (!isFirebasePasswordFallbackError(error)) {
        throw error;
      }

      response = await EduService.login(identifier, password, {
        forceLogoutOtherSessions: options?.forceLogoutOtherSessions,
      });
    }

    setUser(response.user);
  };

  const register = async (payload: RegisterPayload) => {
    await applyPersistence(true);
    const normalizedEmail = String(payload.email || '').trim();
    const firebaseCredential = await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, payload.password);
    try {
      const nextName = String(payload.name || '').trim();
      if (nextName) {
        await updateFirebaseProfile(firebaseCredential.user, { displayName: nextName });
      }
      const idToken = await firebaseCredential.user.getIdToken(true);
      const response: AuthResponse = await EduService.firebaseLogin('password', idToken, {
        name: nextName,
        mobileNumber: payload.mobileNumber || undefined,
      });
      setUser(response.user);
    } catch (error) {
      await deleteUser(firebaseCredential.user).catch(() => undefined);
      throw error;
    }
  };

  const requestPasswordReset = async (email: string) => {
    await sendPasswordResetEmail(
      firebaseAuth,
      String(email || '').trim(),
      getPasswordResetActionSettings(),
    );
  };

  const updateProfile = async (payload: { name: string; mobileNumber?: string | null }) => {
    const response = await EduService.updateProfile(payload);
    setUser(response.user);
  };

  const emitLogoutEvent = () => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({
        type: 'logout',
        userId: user?._id || null,
        sessionId: user?.session || null,
        issuedAt: new Date().toISOString(),
      }));
      window.localStorage.removeItem(AUTH_EVENT_KEY);
    } catch {
      // Ignore storage-event failures and rely on direct state updates.
    }
  };

  const changePassword = async (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
    const activeFirebaseUser = firebaseAuth.currentUser;
    const normalizedEmail = String(user?.email || activeFirebaseUser?.email || '').trim();

    if (activeFirebaseUser && normalizedEmail && activeFirebaseUser.email === normalizedEmail) {
      const credential = EmailAuthProvider.credential(normalizedEmail, payload.currentPassword);
      await reauthenticateWithCredential(activeFirebaseUser, credential);
      await updatePassword(activeFirebaseUser, payload.newPassword);
    }

    await EduService.changePassword(payload);
    EduService.clearToken();
    await signOut(firebaseAuth).catch(() => undefined);
    emitLogoutEvent();
    setUser(null);
  };

  const logout = async () => {
    if (typeof window !== 'undefined') {
      try {
        await (window as WindowWithProgressFlush).__edumasterFlushProgress?.();
      } catch (error) {
        console.error('Failed to flush lesson progress before logout:', error);
      }
    }

    await EduService.logout();
    await signOut(firebaseAuth).catch(() => undefined);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin: user?.role === 'admin',
        login,
        register,
        requestPasswordReset,
        updateProfile,
        changePassword,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
  const applyPersistence = async (rememberMe = true) => {
    await setPersistence(firebaseAuth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  };
