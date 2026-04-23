"use client";

import { SessionProvider } from "next-auth/react";
import { AuthSync } from "@/components/AuthSync";
import { RealtimeProvider } from "@/components/RealtimeProvider";

export function AuthenticatedAppProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <AuthSync />
      <RealtimeProvider />
      {children}
    </SessionProvider>
  );
}
