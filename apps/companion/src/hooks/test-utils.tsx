import { type ReactElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Build a fresh `QueryClient` configured for tests: no retries (so a
 * mocked rejection doesn't sit in `pending` for 3 attempts before
 * surfacing), no cached `gcTime` (every test starts clean even if
 * the same key shows up later), and no refetch-on-mount churn.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnMount: true },
      mutations: { retry: false },
    },
  });
}

export function withQueryClient(
  client: QueryClient = createTestQueryClient(),
): (props: { children: ReactNode }) => ReactElement {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
