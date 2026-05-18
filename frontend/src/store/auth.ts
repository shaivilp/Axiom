import { create } from 'zustand';
import { clearToken, getToken, setToken } from '@/lib/api';
import { wsManager } from '@/lib/ws';

interface AuthState {
  token: string | null;
  setAuthToken: (token: string) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: getToken(),
  setAuthToken: (token) => {
    setToken(token);
    set({ token });
    wsManager.connect();
  },
  logout: () => {
    clearToken();
    wsManager.disconnect();
    set({ token: null });
  },
}));
