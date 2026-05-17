"use client";

import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthSync } from "@/components/AuthSync";
import { RealtimeProvider } from "@/components/RealtimeProvider";

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

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <AuthSync />
        <RealtimeProvider />
        {children}
      </QueryClientProvider>
    </SessionProvider>
  );
}
