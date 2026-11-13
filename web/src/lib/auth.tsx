import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, UNAUTHORIZED_EVENT } from './api';
import { homeFor, type Role } from './roles';

export interface SessionUser {
  id: string;
  kind: 'STAFF' | 'PATIENT';
  role: Role;
  name: string;
  staffCode: string | null;
  mrn: string | null;
  permissions: string[];
}

export interface MeResponse {
  user: SessionUser;
  idleTimeoutSeconds: number;
  newlyRegistered?: boolean;
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  /** Why the last session ended ("SESSION_EXPIRED"), shown on the login page. */
  endedReason: string | null;
  signedIn: (me: MeResponse) => void;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [endedReason, setEndedReason] = useState<string | null>(null);

  useEffect(() => {
    api<MeResponse>('/api/auth/me')
      .then((me) => setUser(me.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onUnauthorized = (e: Event) => {
      setEndedReason((e as CustomEvent<string>).detail ?? 'SESSION_EXPIRED');
      setUser(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signedIn = useCallback((me: MeResponse) => {
    setEndedReason(null);
    setUser(me.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setEndedReason(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, endedReason, signedIn, logout, can: (p) => !!user?.permissions.includes(p) }),
    [user, loading, endedReason, signedIn, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Route guard: signed-in users with one of `roles` only; everyone else goes to login or their own home. */
export function RequireAuth({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

/** "/" → the user's home, or the login page. */
export function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}
