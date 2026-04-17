/**
 * Auth store — verifies the state transitions we depend on in the
 * navigation guards and the login / logout flows.
 *
 * These tests hit the real Zustand store; we reset state in beforeEach
 * so each case is independent.
 */

import { useAuthStore } from '../index';
import type { User } from '@/types';

const INITIAL_STATE = {
  user: null,
  isAuthenticated: false,
  isLoading: true,
};

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState(INITIAL_STATE);
  });

  it('starts with no user and isLoading=true', () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(true);
  });

  it('setUser(user) marks authenticated and ends loading', () => {
    const user = { id: 'u1', email: 'rider@example.com' } as unknown as User;
    useAuthStore.getState().setUser(user);

    const state = useAuthStore.getState();
    expect(state.user).toBe(user);
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it('setUser(null) clears authentication', () => {
    useAuthStore.getState().setUser({ id: 'u1' } as User);
    useAuthStore.getState().setUser(null);

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
  });

  it('logout() clears user and auth flag', () => {
    useAuthStore.getState().setUser({ id: 'u1' } as User);
    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setLoading(false) flips isLoading without touching user', () => {
    const user = { id: 'u1' } as User;
    useAuthStore.getState().setUser(user);
    useAuthStore.getState().setLoading(true);

    expect(useAuthStore.getState().isLoading).toBe(true);
    expect(useAuthStore.getState().user).toBe(user);
  });
});
