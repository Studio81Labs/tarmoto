"use client";

import { useEffect, useState } from "react";
import { getProviders } from "next-auth/react";

export function extractOAuthProviderIds(
  providers: Awaited<ReturnType<typeof getProviders>>,
): string[] {
  if (!providers) return [];

  return Object.keys(providers).filter(
    (providerId) => providerId !== "credentials",
  );
}

export function useOAuthProviders(): string[] {
  const [providerIds, setProviderIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    getProviders()
      .then((providers) => {
        if (cancelled) return;
        setProviderIds(extractOAuthProviderIds(providers));
      })
      .catch(() => {
        if (cancelled) return;
        setProviderIds([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return providerIds;
}
