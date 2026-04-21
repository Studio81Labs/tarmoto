"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth";
import { connectSocket, disconnectSocket } from "@/lib/socket";

/**
 * Opens the shared socket.io connection for the app shell and keeps it in
 * sync with the auth store's access token. The socket reconnects
 * automatically when the token changes (login, logout, refresh). Anonymous
 * connections are allowed — the backend accepts them for hazard alerts.
 */
export function RealtimeProvider() {
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    connectSocket(token);
    return () => {
      disconnectSocket();
    };
  }, [token]);

  return null;
}
