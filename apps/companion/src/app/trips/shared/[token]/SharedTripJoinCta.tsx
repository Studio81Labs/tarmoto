"use client";

import { useTranslation } from "@/i18n/I18nProvider";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Route } from "lucide-react";
import { Button } from "@tarmoto/ui";
import { getUserFacingErrorMessage } from "@/i18n";
import { tripSharesApi } from "@/lib/api";
import { isFeatureLimitError } from "@/lib/entitlements";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/stores/auth";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

interface SharedTripJoinCtaProps {
  token: string;
  title: string;
  tripId: string | null;
}

export function SharedTripJoinCta({
  token,
  title,
  tripId,
}: SharedTripJoinCtaProps) {
  const t = useTranslation();
  // Operator kill switch. This public share route sits outside the planner's
  // wrapper and the invite-code page's, so without this a `trip_planning`
  // force_off still lets an authenticated visitor call `joinByToken` — the
  // backend has no guard on it, making the client the enforcement point.
  //
  // The page itself keeps rendering: it is a public preview of a trip someone
  // chose to share, and hiding that is not what killing trip PLANNING means.
  // Only the join action goes.
  const { enabled: tripPlanningEnabled } =
    useFeatureKillSwitch("trip_planning");
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [joining, setJoining] = useState(false);
  const callbackUrl = useMemo(
    () => `/trips/shared/${encodeURIComponent(token)}`,
    [token],
  );

  // FIRST, ahead of the kill switch: a snapshot-only share has no trip to join
  // and never will, so its state is permanent. Ordering the temporary cause
  // first told the holder of a legacy link to "try again in a little while" —
  // a promise nothing can keep.
  if (!tripId) {
    return (
      <section className="mb-6 rounded-2xl border border-line bg-paper p-6">
        <p className="text-sm text-fg-dim">
          {t(
            "This public preview is read-only. Ask the trip owner for a fresh group collaboration link if you need to suggest route changes.",
          )}
        </p>
      </section>
    );
  }

  // Then the operator kill: a joinable share whose join is paused. Reached
  // only once `tripId` is known to exist, so "try again" is always true here.
  //
  // This used to reuse the read-only copy below, on the reasoning that the
  // preview IS read-only from the visitor's side. True, and useless: that copy
  // tells them to ask the owner for a fresh link, which the owner cannot act
  // on while planning is paused. It sent a real tester hunting a link problem
  // that did not exist. The cause is what the reader needs, and the link is
  // fine — so say both.
  // Cause and action, nothing else. Two earlier drafts each answered a question
  // the reader is not asking — "the link still works" (they are looking at the
  // preview, so it plainly did) and "you won't need a new link" (only worth
  // saying while the copy was still telling them to get one). "Try again in a
  // little while" already implies this link is the one to retry with.
  if (!tripPlanningEnabled) {
    return (
      <section className="mb-6 rounded-2xl border border-line bg-paper p-6">
        <p className="text-sm text-fg-dim">
          {t(
            "Joining is temporarily unavailable. Try again in a little while.",
          )}
        </p>
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="mb-6 rounded-2xl border border-accent/30 bg-accent/[0.06] p-6">
        <h2 className="text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
          {t("Join the planning")}
        </h2>
        <p className="mt-1.5 text-[13.5px] text-fg-dim">
          {t(
            'Sign in or create an account to join "{title}" and open it in your trips.',
            { title },
          )}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="accent"
            leftIcon={<Route size={16} />}
            renderLink={({ className, children }) => (
              <Link
                href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                className={className}
              >
                {children}
              </Link>
            )}
          >
            {t("Sign in to collaborate")}
          </Button>
          <Button
            variant="secondary"
            renderLink={({ className, children }) => (
              <Link
                href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                className={className}
              >
                {children}
              </Link>
            )}
          >
            {t("Create an account")}
          </Button>
        </div>
      </section>
    );
  }

  const handleJoin = async () => {
    if (!authReady || joining) return;
    setJoining(true);
    try {
      const { data } = await tripSharesApi.joinByToken(token);
      // Land on the read-only preview, never the editor: link-joiners
      // default to viewer, and the planner would bounce them to the
      // access-denied screen. From the preview they can open the editor
      // if their role allows it, or leave suggestions if it doesn't.
      router.push(`/trips/${data.trip_id}`);
    } catch (err) {
      // The owner's collaborator cap (max_trip_collaborators) rejects the join
      // with a FEATURE_LIMIT_EXCEEDED 403 — a fresh link won't help, so give
      // the accurate recovery instead of the generic "ask for a new link".
      const message = isFeatureLimitError(err)
        ? t("The trip owner has reached their collaborator limit.")
        : getUserFacingErrorMessage(
            err,
            t(
              "Could not join this shared trip. Ask the owner for a fresh link.",
            ),
          );
      // Persist (no auto-dismiss): the guidance asks the user to take an
      // out-of-band action, so it shouldn't time out.
      toast.error(message, { durationMs: null });
    } finally {
      setJoining(false);
    }
  };

  return (
    <section className="mb-6 rounded-2xl border border-accent/30 bg-accent/[0.06] p-6">
      <h2 className="text-[20px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
        {t("Join the planning")}
      </h2>
      <p className="mt-1.5 text-[13.5px] text-fg-dim">
        {t(
          "Accept this shared trip to open its preview, submit suggestions, and vote with the group.",
        )}
      </p>
      <Button
        variant="accent"
        className="mt-4"
        onClick={handleJoin}
        disabled={!authReady}
        loading={joining}
        leftIcon={<Route size={16} />}
      >
        {t("Join trip")}
      </Button>
    </section>
  );
}
