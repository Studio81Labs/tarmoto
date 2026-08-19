"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useAuthStore } from "@/stores/auth";
import { connectSocket, disconnectSocket } from "@/lib/socket";
import { useTranslation } from "@/i18n/I18nProvider";

/**
 * Routes that never consume realtime events AND whose flows end in a
 * full-page navigation (login/register hand off via
 * `window.location.href`). Opening the socket there means the navigation
 * kills it mid-handshake and the browser logs "cannot establish a
 * connection to wss://…" — pure noise that reads like an outage (it
 * produced a false "websockets are broken" report on the first Coolify
 * staging deploy). The destination page reconnects immediately after the
 * navigation, so nothing is lost by staying socketless here.
 */
const SOCKETLESS_ROUTES = ["/login", "/register", "/forgot-password"];

/**
 * Opens the shared socket.io connection for the app shell and keeps it in
 * sync with the auth store's access token. The socket reconnects
 * automatically when the token changes (login, logout, refresh). Anonymous
 * connections are allowed — the backend accepts them for hazard alerts.
 */
export function RealtimeProvider() {
  const t = useTranslation();
  const token = useAuthStore((s) => s.accessToken);
  const pathname = usePathname();
  const { status } = useSession();
  const socketless = SOCKETLESS_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  // Don't connect until the session state is SETTLED. On every full page
  // load the session starts as "loading" and the store token as null;
  // connecting right away opens an anonymous socket that the token's
  // arrival (via AuthSync, milliseconds later) tears down mid-handshake to
  // reconnect authenticated — one doomed wss attempt per page load, which
  // browsers log as "cannot establish a connection to wss://…". When the
  // session IS authenticated, additionally wait for AuthSync to land the
  // token in the store (same gap, same doomed connection). Genuinely
  // anonymous visitors connect as before once the session settles.
  const ready =
    status === "unauthenticated" ||
    (status === "authenticated" && token !== null);

  useEffect(() => {
    // No connection on socketless routes; a previous connection (SPA
    // navigation into an auth page, e.g. after logout) was already torn
    // down by the prior effect's cleanup when `socketless` flipped.
    if (socketless || !ready) return;
    connectSocket(token, t);
    return () => {
      disconnectSocket();
    };
  }, [token, t, socketless, ready]);

  return null;
}
