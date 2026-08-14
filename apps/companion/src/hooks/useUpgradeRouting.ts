import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useFormat } from "@/format/FormatProvider";
import { useTranslation } from "@/i18n/I18nProvider";
import { accountApi } from "@/lib/api/account";
import {
  normalizeSubscriptionSnapshot,
  upgradeNeedsCheckout,
} from "@/lib/subscription";
import { useAuthStore } from "@/stores/auth";

/** Keyed on the rider, the way `USERS_ME_QUERY_KEY` is. A bare shared key
 *  would leak across an account switch in one browser session: `AuthSync`
 *  clears only the Zustand session, never React Query, so the second rider
 *  could be classified from the first rider's snapshot. */
export const ACCOUNT_SUBSCRIPTION_QUERY_KEY = (userId: string | null) =>
  ["account-subscription", userId] as const;

/**
 * Where this rider's upgrade action would take them — Stripe Checkout, or
 * somewhere `sys_billing_checkout` leaves working (the billing portal, an app
 * store). The single answer to "is this rider's route Checkout or portal",
 * shared by every upsell surface so they cannot disagree.
 *
 * Reads `GET /account/subscription`, because the routing turns on
 * `preview` / `currentPlan` / `managedBy` — none of which the `/users/me`
 * entitlement snapshot carries. All prompts share one cached request.
 *
 * **Fails SAFE toward keeping the CTA.** While the snapshot is loading or has
 * errored, this cannot tell an active paid subscriber (portal — the route
 * still works) from a granted or cancelled one (Checkout). Reporting the
 * unknown as "needs Checkout" would strand an active paid rider with no
 * upgrade route on every slow load, which is worse than the dead end it would
 * be avoiding. So `needsCheckout` is true only once a snapshot CONFIRMS it.
 */
export function useUpgradeRouting(): {
  /** True only once the snapshot confirms Stripe Checkout routing. */
  needsCheckout: boolean;
  /** The routing question has actually been answered. */
  isResolved: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // NextAuth's status distinguishes a CONFIRMED anonymous visitor from the
  // pre-auth hydration window — including the gap where the session is
  // "authenticated" but `AuthSync` hasn't copied the user into the store yet,
  // so `userId` is still null and a signed-in rider transiently looks
  // anonymous. Same guard as `useRoadQualityZoomCap`.
  const { status } = useSession();
  const t = useTranslation();
  const format = useFormat();
  const authed = userId !== null;

  const query = useQuery({
    queryKey: ACCOUNT_SUBSCRIPTION_QUERY_KEY(userId),
    // `GET /account/subscription` is AuthGuard-protected, and `UpgradePrompt`
    // renders on the PUBLIC `/explore` for logged-out visitors — an
    // unconditional fetch would 401 on every anonymous zoom prompt. Only an
    // ANONYMOUS visitor can be answered without it: an authenticated FREE
    // rider may still be a lapsed store subscriber (see
    // `upgradeNeedsCheckout`), so tier alone cannot short-circuit them.
    enabled: authed,
    staleTime: 60_000,
    // A suppressed CTA must not outlive the billing state that justified it.
    // react-query RETAINS the last successful `data` when a refetch fails —
    // and, measurably at v5.100.10, the observer does not even surface that
    // failure (the query's own status flips to error, but the hook result is
    // unchanged and no re-render occurs), so this hook cannot detect it and
    // fall back. What it can do is make the snapshot self-correct: poll while
    // the tab is active and re-confirm on focus, the same cadence
    // `useSystemSwitch` uses for the switch this pairs with. A rider whose
    // routing changes mid-session — a store purchase made on mobile, an
    // operator grant — regains their CTA within the interval instead of at the
    // next reload, and a recovered backend restores the truth on its own.
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => (await accountApi.getSubscription()).data,
  });

  const snapshot = useMemo(
    () =>
      query.data === undefined
        ? null
        : normalizeSubscriptionSnapshot(query.data, t, format.locale),
    [query.data, t, format.locale],
  );

  if (authed) {
    // Both conditions, the way `useLimit` pairs them: a query that has not
    // SUCCEEDED is unresolved, and so is a success that produced no snapshot.
    if (!query.isSuccess || snapshot === null) {
      return { needsCheckout: false, isResolved: false };
    }
    return { needsCheckout: upgradeNeedsCheckout(snapshot), isResolved: true };
  }
  // Confirmed anonymous: no account and so no store subscription or portal to
  // route to — an upgrade starts with sign-up and Stripe Checkout.
  if (status === "unauthenticated") {
    return { needsCheckout: true, isResolved: true };
  }
  // Auth still hydrating. Unknown, so keep the CTA.
  return { needsCheckout: false, isResolved: false };
}
