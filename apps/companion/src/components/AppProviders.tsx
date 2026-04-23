"use client";

import { SessionProvider } from "next-auth/react";
import { usePathname } from "next/navigation";
import { AuthSync } from "@/components/AuthSync";
import { RealtimeProvider } from "@/components/RealtimeProvider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return children;
  }

  return (
    <SessionProvider>
      <AuthSync />
      <RealtimeProvider />
      {children}
    </SessionProvider>
  );
}
