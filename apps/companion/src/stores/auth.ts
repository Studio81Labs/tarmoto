import { create } from "zustand";

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  phone?: string;
}

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  accessToken: string | null;

  setSession: (user: AuthUser, accessToken: string) => void;
  setUser: (user: AuthUser) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  accessToken: null,

  setSession: (user, accessToken) =>
    set({ user, isAuthenticated: true, accessToken }),

  setUser: (user) => set({ user }),

  clearSession: () =>
    set({ user: null, isAuthenticated: false, accessToken: null }),
}));
