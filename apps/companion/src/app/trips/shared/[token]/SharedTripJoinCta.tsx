"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Route } from "lucide-react";
import { Button } from "@tarmoto/ui";
import { getUserFacingErrorMessage, t } from "@/i18n";
import { tripSharesApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/stores/auth";

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
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const [joining, setJoining] = useState(false);
  const callbackUrl = useMemo(
    () => `/trips/shared/${encodeURIComponent(token)}`,
    [token],
  );

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
      // Persist (no auto-dismiss): the guidance asks the user to take an
      // out-of-band action (get a fresh link), so it shouldn't time out.
      toast.error(
        getUserFacingErrorMessage(
          err,
          t("Could not join this shared trip. Ask the owner for a fresh link."),
        ),
        { durationMs: null },
      );
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
