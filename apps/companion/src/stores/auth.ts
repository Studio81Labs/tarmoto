import { create } from 'zustand';
import type { User } from '@/lib/types';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setAuth: (user: User, token: string) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

const isBrowser = typeof window !== 'undefined';

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: isBrowser ? localStorage.getItem('tarmoto_token') : null,
  isAuthenticated: isBrowser ? !!localStorage.getItem('tarmoto_token') : false,
  isLoading: false,

  setAuth: (user, token) => {
    if (isBrowser) localStorage.setItem('tarmoto_token', token);
    set({ user, token, isAuthenticated: true });
  },

  logout: () => {
    if (isBrowser) localStorage.removeItem('tarmoto_token');
    set({ user: null, token: null, isAuthenticated: false });
  },

  setLoading: (isLoading) => set({ isLoading }),
}));
