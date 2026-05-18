import { create } from 'zustand';
import { api } from '@/lib/api';
import { wsManager } from '@/lib/ws';

/**
 * Session state. The actual credential lives in an HttpOnly cookie set by
 * /api/v1/auth/login — the SPA never sees the token after login. We only
 * track an `authenticated` flag so the router knows which routes to render.
 *
 * On boot, App.tsx calls `bootstrap()` which probes /whoami:
 *   - 200 → authenticated
 *   - 401 → unauthenticated (Login screen)
 */
type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  bootstrap: () => Promise<void>;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  markUnauthenticated: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'unknown',
  bootstrap: async () => {
    try {
      await api.whoami();
      set({ status: 'authenticated' });
      wsManager.connect();
    } catch {
      // 401 (or other failure) → not authenticated. The 401 handler will
      // already have fired markUnauthenticated, but set it here too in case
      // the failure was network-level.
      set({ status: 'unauthenticated' });
    }
  },
  login: async (token: string) => {
    await api.login(token);
    set({ status: 'authenticated' });
    wsManager.connect();
  },
  logout: async () => {
    try {
      await api.logout();
    } catch {
      // Even if the API call fails, drop our local state. The cookie will
      // expire on its own; the user can always retry login.
    }
    wsManager.disconnect();
    set({ status: 'unauthenticated' });
  },
  markUnauthenticated: () => {
    wsManager.disconnect();
    set({ status: 'unauthenticated' });
  },
}));
