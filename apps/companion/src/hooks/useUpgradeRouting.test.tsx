import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createTestQueryClient, withQueryClient } from "./test-utils";

const getSubscriptionMock = vi.fn();
const { authState, sessionState } = vi.hoisted(() => ({
  authState: { user: { id: "u1" } as { id: string } | null },
  sessionState: {
    status: "authenticated" as "loading" | "authenticated" | "unauthenticated",
  },
}));
vi.mock("@/lib/api/account", () => ({
  accountApi: { getSubscription: () => getSubscriptionMock() },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel(authState),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: sessionState.status }),
}));

import {
  ACCOUNT_SUBSCRIPTION_QUERY_KEY,
  useUpgradeRouting,
} from "./useUpgradeRouting";

/** Only the fields the routing decision reads — the normalizer fills the rest
 *  from its fallback, which is exactly what a partial payload does in prod. */
function snapshotPayload(current: {
  tier: string;
  status: string;
  managed_by?: string | null;
}) {
  return {
    current_plan: { tier: current.tier, status: current.status },
    managed_by: current.managed_by ?? null,
    plans: [],
    billing_history: [],
  };
}

describe("useUpgradeRouting", () => {
  beforeEach(() => {
    getSubscriptionMock.mockReset();
    authState.user = { id: "u1" };
    sessionState.status = "authenticated";
  });

  it("answers a confirmed anonymous visitor without a request", async () => {
    authState.user = null;
    sessionState.status = "unauthenticated";
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    // No account → no store subscription and no portal; an upgrade starts with
    // sign-up and Checkout. `GET /account/subscription` is AuthGuard-protected,
    // so asking would only 401 on every anonymous `/explore` zoom prompt.
    expect(result.current.needsCheckout).toBe(true);
    expect(getSubscriptionMock).not.toHaveBeenCalled();
  });

  it("stays unresolved while auth is still hydrating", async () => {
    // Session says authenticated but `AuthSync` hasn't copied the rider into
    // the store yet — a signed-in rider transiently looks anonymous here.
    authState.user = null;
    sessionState.status = "loading";
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(false));
    expect(result.current.needsCheckout).toBe(false);
    expect(getSubscriptionMock).not.toHaveBeenCalled();
  });

  it("reports Checkout routing for a free rider", async () => {
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({ tier: "free", status: "active" }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.needsCheckout).toBe(true);
  });

  it("reports Checkout routing for a paid rider on a canceled plan (grant)", async () => {
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({ tier: "pro", status: "canceled" }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    // No live Stripe subscription behind the tier, so the billing page routes
    // every plan action through Checkout.
    expect(result.current.needsCheckout).toBe(true);
  });

  it("reports portal routing for an active paid rider", async () => {
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({
        tier: "pro",
        status: "active",
        managed_by: "stripe_portal",
      }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.needsCheckout).toBe(false);
  });

  it("reports store routing for a LAPSED store rider reading as free", async () => {
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({
        tier: "free",
        status: "canceled",
        managed_by: "app_store",
      }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    // `managed_by` is derived independently of tier, so a free-reading store
    // rider still manages their plan in the store — a path this switch does
    // not gate. Short-circuiting on tier alone would have said Checkout.
    expect(result.current.needsCheckout).toBe(false);
  });

  it("claims no routing for a preview snapshot", async () => {
    // Unnormalizable tier/status → the synthesized demo plan. It describes no
    // real routing, so it must not be read as one.
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({ tier: "nonsense", status: "nonsense" }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.needsCheckout).toBe(false);
  });

  it("keeps the routing unknown while the snapshot is in flight", async () => {
    getSubscriptionMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(getSubscriptionMock).toHaveBeenCalled());
    // An active paid subscriber is indistinguishable from a granted one here;
    // guessing "Checkout" would strand them with no upgrade route.
    expect(result.current.needsCheckout).toBe(false);
    expect(result.current.isResolved).toBe(false);
  });

  it("keeps the routing unknown when the snapshot request fails", async () => {
    getSubscriptionMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(getSubscriptionMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isResolved).toBe(false));
    expect(result.current.needsCheckout).toBe(false);
  });

  it("re-confirms routing that changes under a loaded snapshot", async () => {
    // A rider whose route changes mid-session — a store purchase made on
    // mobile, an operator grant — must regain their CTA. react-query retains
    // the last successful `data` across a failed refetch (and at v5.100.10
    // does not even surface that failure to the observer), so the snapshot
    // cannot fall back on its own; what rescues it is that the query
    // re-confirms on focus and on the poll rather than answering from one
    // fetch for the whole session.
    const client = createTestQueryClient();
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({ tier: "free", status: "active" }),
    });
    const { result } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(client),
    });
    await waitFor(() => expect(result.current.needsCheckout).toBe(true));

    // A re-confirmation that FAILS leaves the prior answer standing — and the
    // query's own state proves the failure landed while the hook result never
    // moved, which is the behaviour that makes an `isError` fallback
    // impossible here rather than merely unnecessary.
    getSubscriptionMock.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await client.refetchQueries({
        queryKey: ACCOUNT_SUBSCRIPTION_QUERY_KEY("u1"),
      });
    });
    expect(getSubscriptionMock).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryState(ACCOUNT_SUBSCRIPTION_QUERY_KEY("u1"))?.status,
    ).toBe("error");
    expect(result.current.needsCheckout).toBe(true);

    // The next re-confirmation that SUCCEEDS is what corrects it.
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({
        tier: "pro",
        status: "active",
        managed_by: "app_store",
      }),
    });
    await act(async () => {
      await client.refetchQueries({
        queryKey: ACCOUNT_SUBSCRIPTION_QUERY_KEY("u1"),
      });
    });
    // `needsCheckout` alone would also read false while UNRESOLVED, so pin
    // both. react-query notifies through its own scheduler, which can land
    // after `act` returns — assert on the settled result, not the next tick.
    await waitFor(() => {
      expect(result.current.needsCheckout).toBe(false);
      expect(result.current.isResolved).toBe(true);
    });
  });

  it("does not classify a rider from the previous account's snapshot", async () => {
    // One browser session, two riders: `AuthSync` clears the Zustand session
    // but never React Query, so a bare shared key would still be cached and
    // fresh (staleTime 60s) when the second rider mounts.
    const client = createTestQueryClient();
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({ tier: "free", status: "active" }),
    });
    const { result, rerender } = renderHook(() => useUpgradeRouting(), {
      wrapper: withQueryClient(client),
    });
    await waitFor(() => expect(result.current.needsCheckout).toBe(true));

    authState.user = { id: "u2" };
    getSubscriptionMock.mockResolvedValue({
      data: snapshotPayload({
        tier: "premium",
        status: "active",
        managed_by: "stripe_portal",
      }),
    });
    rerender();
    await waitFor(() => expect(result.current.needsCheckout).toBe(false));
    expect(getSubscriptionMock).toHaveBeenCalledTimes(2);
  });
});
