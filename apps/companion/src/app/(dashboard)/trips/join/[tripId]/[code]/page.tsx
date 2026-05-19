"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { ApiError, tripsApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

type JoinState =
  | { kind: "joining" }
  | { kind: "success" }
  | { kind: "error"; status: number | null; message: string };

/**
 * Landing page for trip-invite emails. The invite mail (sent by
 * `POST /trips/:tripId/invite`) links here with both segments in the
 * path so the auth middleware's pathname-only `callbackUrl` can
 * round-trip an unauthenticated invitee through `/login` without
 * dropping the code.
 *
 * On mount we POST `/trips/:tripId/join` with the invite code, and
 * either redirect to the trip detail (success / already a member —
 * the backend dedupes via the `(trip_id, user_id)` unique index) or
 * surface a clear error UI when the code is wrong or the trip no
 * longer exists.
 */
export default function TripInviteJoinPage() {
  const { tripId, code } = useParams<{ tripId: string; code: string }>();
  const router = useRouter();
  const [state, setState] = useState<JoinState>({ kind: "joining" });
  // Wait for `AuthSync` to hydrate the bearer token into
  // `useAuthStore` before posting. On a hard navigation right after
  // login/register the NextAuth session is mid-flight while the
  // landing component already mounts; if the join effect ran now
  // `apiFetch` would read `accessToken === null`, send an
  // unauthenticated POST, hit the global 401 handler, and
  // `clearSession` — wiping the just-issued credentials. Mirrors the
  // `authReady` gate the trip detail page already uses for the same
  // race.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  // Stash the router on a ref so the join effect doesn't list it in
  // its dep array. Each `useRouter()` call returns a fresh object
  // identity in jsdom-mocked tests (and at the framework level,
  // referential stability isn't guaranteed) — including it in deps
  // would re-fire the effect on every render and tight-loop the
  // setState path.
  const routerRef = useRef(router);
  routerRef.current = router;
  // StrictMode double-invokes effects in dev — without this guard the
  // second pass would fire a second POST that the backend dedupes,
  // but it would also flicker the user from "joining" to "success"
  // twice. The ref scopes the dedupe to the lifetime of this client
  // mount.
  const joinedOnce = useRef(false);

  useEffect(() => {
    if (!tripId || !code) {
      setState({
        kind: "error",
        status: null,
        message: "Missing trip id or invite code in the URL.",
      });
      return;
    }
    // Hold the spinner until AuthSync writes the bearer into the auth
    // store. The effect re-fires when `authReady` flips to true, and
    // `joinedOnce` keeps the actual POST single-shot afterwards.
    if (!authReady) return;
    if (joinedOnce.current) return;
    joinedOnce.current = true;

    // No `cancelled` flag + cleanup pair here: under React StrictMode
    // the dev double-invoke runs the cleanup of the first effect
    // before the second pass, then the second pass exits early
    // because `joinedOnce.current` is already `true`. With a
    // `cancelled` gate, the first POST's resolution would hit the
    // gate and skip the setState, leaving the page stuck on the
    // "Accepting…" spinner forever (Bugbot #38db6ed2). React 18+
    // silently ignores setState on unmounted components, so it's
    // safe to drop the gate entirely — the worst case is one extra
    // setState that React no-ops.
    void (async () => {
      try {
        await tripsApi.join(tripId, code);
        setState({ kind: "success" });
        routerRef.current.replace(`/trips/${tripId}`);
      } catch (err) {
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            status: err.status,
            message:
              err.status === 403
                ? "This invite link is invalid or has been revoked. Ask the trip owner for a new one."
                : err.status === 401
                  ? "Sign in to accept this trip invite."
                  : err.message ||
                    "Could not accept this invite. Please try again later.",
          });
        } else {
          setState({
            kind: "error",
            status: null,
            message:
              err instanceof Error
                ? err.message
                : "Could not accept this invite. Please try again later.",
          });
        }
      }
    })();
  }, [tripId, code, authReady]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      {state.kind === "joining" && (
        <>
          <Loader2 className="mb-4 h-10 w-10 animate-spin text-accent" />
          <h1 className="text-xl font-semibold text-ink">
            Accepting your trip invite…
          </h1>
          <p className="mt-2 text-sm text-fg-dim">
            Hang tight while we add you to the trip.
          </p>
        </>
      )}

      {state.kind === "success" && (
        <>
          <Check className="mb-4 h-10 w-10 text-quality-excellent" />
          <h1 className="text-xl font-semibold text-ink">You&apos;re in!</h1>
          <p className="mt-2 text-sm text-fg-dim">Taking you to the trip…</p>
        </>
      )}

      {state.kind === "error" && (
        <>
          <AlertTriangle className="mb-4 h-10 w-10 text-amber-400" />
          <h1 className="text-xl font-semibold text-ink">
            We couldn&apos;t accept this invite
          </h1>
          <p className="mt-2 text-sm text-fg-dim">{state.message}</p>
          <div className="mt-6 flex gap-3">
            <Link
              href="/trips"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-ink font-bold text-[11px] uppercase tracking-[0.2px] hover:brightness-95 transition"
            >
              Go to my trips
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
