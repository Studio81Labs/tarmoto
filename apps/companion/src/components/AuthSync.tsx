"use client";

import { useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useAuthStore } from "@/stores/auth";

export function AuthSync() {
  const { data: session, status } = useSession();
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);

  useEffect(() => {
    if (status === "authenticated" && session?.user) {
      setSession(
        {
          id: session.user.id,
          email: session.user.email!,
          displayName: session.user.displayName,
          phone: session.user.phone,
        },
        session.accessToken,
      );

      if (session.error === "RefreshTokenError") {
        signOut({ callbackUrl: "/login" });
      }
    } else if (status === "unauthenticated") {
      clearSession();
    }
  }, [session, status, setSession, clearSession]);

  return null;
}
