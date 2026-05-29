import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  ActionCodeSettings,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile as updateFirebaseProfile,
} from 'firebase/auth';
import type { FirebaseError } from 'firebase/app';
import { EduService } from './EduService';
import { auth as firebaseAuth } from './firebase';
import { AuthResponse, AuthUser, RegisterPayload } from './types';

const AUTH_EVENT_KEY = 'edumaster.auth.event';
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
  ].includes(code);
};

type WindowWithProgressFlush = Window & {
  __edumasterFlushProgress?: () => Promise<void>;
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
  updateProfile: (payload: { name: string; email: string; mobileNumber?: string | null }) => Promise<void>;
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

    const handleAuthExpired = () => {
      setUser(null);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_EVENT_KEY || !event.newValue) {
        return;
      }

      try {
        const payload = JSON.parse(event.newValue) as { type?: 'login' | 'logout' };
        if (payload.type === 'logout') {
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
  }, []);

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

  const updateProfile = async (payload: { name: string; email: string; mobileNumber?: string | null }) => {
    const response = await EduService.updateProfile(payload);
    setUser(response.user);
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
