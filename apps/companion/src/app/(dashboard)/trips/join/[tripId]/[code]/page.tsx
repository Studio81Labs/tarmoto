"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Loader2,
  Route as RouteIcon,
} from "lucide-react";
import { ApiError, tripsApi, type TripInvitePreview } from "@/lib/api";
import type { RoutePoint } from "@/lib/ride-detail";
import { TripRouteOverview } from "@/components/TripRouteOverview";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuthStore } from "@/stores/auth";
import {
  getUserFacingErrorMessage,
  type EnglishMessageKey,
  type Translate,
} from "@/i18n";
import { translateKnownLabel } from "@/i18n/domainLabels";
import { KillSwitchGate } from "@/components/entitlements/KillSwitchGate";

type JoinState =
  | { kind: "loading" }
  | { kind: "preview"; preview: TripInvitePreview }
  | { kind: "accepting"; preview: TripInvitePreview }
  | { kind: "error"; message: string };

/**
 * Landing page for trip-invite emails. The invite mail (sent by
 * `POST /trips/:tripId/invite`) links here with both segments in the path so
 * the auth middleware's pathname-only `callbackUrl` can round-trip an
 * unauthenticated invitee through `/login` without dropping the code.
 *
 * Once signed in we fetch a masked preview of the trip (route overview + who
 * invited them + the role they'll get) and let the rider review it before an
 * explicit "Accept invitation" — accepting is what POSTs `/trips/:id/join` and
 * actually adds them to the (otherwise private) trip. An already-member is
 * sent straight to the trip.
 */
/**
 * Operator kill switch. `/trips/planner` is gated by its own wrapper, but this
 * invite deep-link sits outside it and would otherwise still fetch the preview
 * and run `tripsApi.join` while `trip_planning` is killed — the backend has no
 * guard on that operation, so the client gate is the enforcement point.
 */
export default function TripInviteJoinPage() {
  return (
    <KillSwitchGate feature="trip_planning">
      <TripInviteJoinPageInner />
    </KillSwitchGate>
  );
}

function TripInviteJoinPageInner() {
  const t = useTranslation();
  const { tripId, code } = useParams<{ tripId: string; code: string }>();
  const router = useRouter();
  const [state, setState] = useState<JoinState>({ kind: "loading" });
  // Wait for `AuthSync` to hydrate the bearer token before calling the API —
  // on a hard navigation right after login the NextAuth session is mid-flight
  // while this component already mounts; firing now would send an
  // unauthenticated request, hit the global 401 handler, and wipe the
  // just-issued credentials.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  const routerRef = useRef(router);
  routerRef.current = router;
  // StrictMode double-invokes effects in dev; keep the preview fetch
  // single-shot for the lifetime of this mount.
  const fetchedOnce = useRef(false);

  useEffect(() => {
    if (!tripId || !code) {
      setState({
        kind: "error",
        message: t("Missing trip id or invite code in the URL."),
      });
      return;
    }
    if (!authReady) return;
    if (fetchedOnce.current) return;
    fetchedOnce.current = true;

    void (async () => {
      try {
        const { data } = await tripsApi.getInvitePreview(tripId, code);
        // Already a member — nothing to accept; go straight to the trip.
        if (data.already_member) {
          routerRef.current.replace(`/trips/${tripId}`);
          return;
        }
        setState({ kind: "preview", preview: data });
      } catch (err) {
        setState({ kind: "error", message: messageForError(err, t) });
      }
    })();
  }, [t, tripId, code, authReady]);

  const handleAccept = useCallback(async () => {
    if (state.kind !== "preview") return;
    setState({ kind: "accepting", preview: state.preview });
    try {
      await tripsApi.join(tripId, code);
      routerRef.current.replace(`/trips/${tripId}`);
    } catch (err) {
      setState({ kind: "error", message: messageForError(err, t) });
    }
  }, [t, state, tripId, code]);

  if (state.kind === "loading") {
    return (
      <Centered>
        <Loader2 className="mb-4 h-10 w-10 animate-spin text-accent" />
        <h1 className="text-xl font-semibold text-ink">
          {t("Loading your invite…")}
        </h1>
      </Centered>
    );
  }

  if (state.kind === "error") {
    return (
      <Centered>
        <AlertTriangle className="mb-4 h-10 w-10 text-amber-700" />
        <h1 className="text-xl font-semibold text-ink">
          {t("We couldn't open this invite")}
        </h1>
        <p className="mt-2 text-sm text-fg-dim">{state.message}</p>
        <div className="mt-6">
          <Link
            href="/trips"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:brightness-95"
          >
            {t("Go to my trips")}
          </Link>
        </div>
      </Centered>
    );
  }

  const { preview } = state;
  const accepting = state.kind === "accepting";
  const lines = toRouteLines(preview.lines);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-accent">
        <RouteIcon size={14} />
        {t("Trip invitation")}
      </div>
      <h1 className="text-2xl font-extrabold tracking-tight text-ink">
        {preview.title}
      </h1>
      <div className="mt-3 flex items-center gap-2.5 text-sm text-fg-dim">
        <UserAvatar
          name={preview.invited_by_name ?? t("A rider")}
          size={22}
          fontSize={10}
          accent
        />
        <span>
          {preview.invited_by_name
            ? t("{name} invited you to collaborate as {role}.", {
                name: preview.invited_by_name,
                role: roleLabel(preview.role, t),
              })
            : t("You've been invited to collaborate as {role}.", {
                role: roleLabel(preview.role, t),
              })}
        </span>
      </div>

      <div className="mt-6">
        <TripRouteOverview
          lines={lines}
          distanceKm={preview.distance_km}
          dayCount={preview.num_days}
          region={preview.region}
          label={preview.title}
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void handleAccept()}
          disabled={accepting}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {accepting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Check size={16} />
          )}
          {accepting ? t("Accepting…") : t("Accept invitation")}
        </button>
        <Link
          href="/trips"
          className="inline-flex items-center rounded-lg border border-line-strong px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.2px] text-fg-dim transition hover:border-fg-mute hover:text-ink"
        >
          {t("Not now")}
        </Link>
      </div>
    </div>
  );
}

// Backend `lines` are per-day [lng,lat] polylines. Keep them separate (one
// RoutePoint[] per day) so the preview doesn't connect non-adjacent days.
function toRouteLines(lines: number[][][]): RoutePoint[][] {
  return lines.map((line) => {
    const out: RoutePoint[] = [];
    for (const point of line) {
      const [lng, lat] = point;
      if (typeof lat === "number" && typeof lng === "number") {
        out.push({ lat, lng });
      }
    }
    return out;
  });
}

function roleLabel(role: TripInvitePreview["role"], t: Translate): string {
  const labels = {
    owner: "the owner",
    editor: "an editor",
    viewer: "a viewer",
  } as const satisfies Record<TripInvitePreview["role"], EnglishMessageKey>;
  return translateKnownLabel(role, labels, t);
}

function messageForError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return t(
        "This invite link is invalid or has been revoked. Ask the trip owner for a new one.",
      );
    }
    if (err.status === 401) {
      return t("Sign in to open this trip invite.");
    }
  }
  return getUserFacingErrorMessage(
    err,
    t("Could not open this invite. Please try again later."),
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      {children}
    </div>
  );
}
