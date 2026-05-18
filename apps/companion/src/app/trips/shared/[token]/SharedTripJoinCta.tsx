"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Route } from "lucide-react";
import { tripSharesApi } from "@/lib/api";
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
  const [error, setError] = useState<string | null>(null);
  const callbackUrl = useMemo(
    () => `/trips/shared/${encodeURIComponent(token)}`,
    [token],
  );

  if (!tripId) {
    return (
      <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <p className="text-sm text-slate-300">
          This public preview is read-only. Ask the trip owner for a fresh group
          collaboration link if you need to suggest route changes.
        </p>
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="mb-8 rounded-2xl border border-cyan-400/25 bg-cyan-400/10 p-5">
        <h2 className="text-lg font-semibold text-white">Join the planning</h2>
        <p className="mt-1 text-sm text-slate-300">
          Sign in or create an account to join "{title}" and open it in the
          collaborative planner.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
          >
            <Route size={16} />
            Sign in to collaborate
          </Link>
          <Link
            href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-500"
          >
            Create an account
          </Link>
        </div>
      </section>
    );
  }

  const handleJoin = async () => {
    if (!authReady || joining) return;
    setJoining(true);
    setError(null);
    try {
      const { data } = await tripSharesApi.joinByToken(token);
      router.push(data.planner_url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not join this shared trip. Ask the owner for a fresh link.",
      );
    } finally {
      setJoining(false);
    }
  };

  return (
    <section className="mb-8 rounded-2xl border border-cyan-400/25 bg-cyan-400/10 p-5">
      <h2 className="text-lg font-semibold text-white">Join the planning</h2>
      <p className="mt-1 text-sm text-slate-300">
        Accept this shared trip to open the planner, submit suggestions, and
        vote with the group.
      </p>
      <button
        type="button"
        onClick={handleJoin}
        disabled={!authReady || joining}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {joining ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Route size={16} />
        )}
        Join trip
      </button>
      {error ? (
        <p
          role="alert"
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
        >
          <AlertTriangle size={14} />
          {error}
        </p>
      ) : null}
    </section>
  );
}
