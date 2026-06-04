"use client";

import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthSync } from "@/components/AuthSync";
import { RealtimeProvider } from "@/components/RealtimeProvider";
import { PreferencesSync } from "@/components/PreferencesSync";

export function AuthenticatedAppProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  // One QueryClient per component instance. Built lazily inside
  // useState so React's strict-mode double-mount in dev doesn't get
  // two clients; closes over no shared state, so each instance
  // gets its own isolated cache.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // Re-fetch the NextAuth session every 4 minutes. The backend
  // access token lives for 1 hour (auth.service.ts ACCESS_TOKEN_EXPIRY)
  // and the `jwt` callback refreshes it lazily when the session is
  // requested; without a polling cadence, a user who keeps the planner
  // open past the 1h mark hits 401 on the next API call because the
  // session in client state still carries the expired token. 4 min
  // leaves plenty of headroom against the 5 min refresh buffer used by
  // the `jwt` callback.
  return (
    <SessionProvider refetchInterval={4 * 60} refetchOnWindowFocus>
      <QueryClientProvider client={queryClient}>
        <AuthSync />
        <RealtimeProvider />
        <PreferencesSync />
        {children}
      </QueryClientProvider>
    </SessionProvider>
  );
}
