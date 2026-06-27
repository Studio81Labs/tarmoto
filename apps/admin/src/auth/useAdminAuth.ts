import { useCallback, useEffect, useRef, useState } from "react";
import { adminAuthApi, type AdminUserView } from "./adminAuthApi.js";
import { ADMIN_AUTH_EXPIRED_EVENT } from "../data/apiClient.js";

type Status = "loading" | "authenticated" | "unauthenticated";

export interface AdminAuthState {
  status: Status;
  user: AdminUserView | null;
  error: string | null;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAdminAuth(): AdminAuthState {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AdminUserView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    adminAuthApi
      .getCurrentAdmin()
      .then((found) => {
        if (!active) return;
        setUser(found);
        setStatus(found ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        if (!active) return;
        setStatus("unauthenticated");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setStatus("unauthenticated");
    };
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
    return () =>
      window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const loginWithPassword = useCallback(
    async (email: string, password: string) => {
      if (mountedRef.current) setError(null);
      try {
        const found = await adminAuthApi.loginWithPassword(email, password);
        if (mountedRef.current) {
          setUser(found);
          setStatus("authenticated");
        }
      } catch {
        if (mountedRef.current) setError("Invalid credentials");
        throw new Error("Invalid credentials");
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await adminAuthApi.logout();
      if (mountedRef.current) {
        setUser(null);
        setStatus("unauthenticated");
      }
    } catch {
      if (mountedRef.current) setError("Logout failed. Please try again.");
    }
  }, []);

  return { status, user, error, loginWithPassword, logout };
}
