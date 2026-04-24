"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Link as LinkIcon, Loader2, X } from "lucide-react";
import { ApiError, tripSharesApi, type TripShareResponse } from "@/lib/api";
import type { Trip } from "@/lib/types";

interface TripCollaborateModalProps {
  open: boolean;
  trip: Trip | null;
  onClose: () => void;
}

/**
 * US-35 (first slice) — generate a read-only invite link for the active
 * trip. The full collaboration surface (real-time cursors, route
 * suggestions, voting, activity log) is tracked in follow-up issues;
 * this modal covers the "shareable invite link, no account required to
 * view" acceptance criterion.
 */
export function TripCollaborateModal({
  open,
  trip,
  onClose,
}: TripCollaborateModalProps) {
  const [share, setShare] = useState<TripShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setShare(null);
      setError(null);
      setCopied(false);
      return;
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const handleGenerate = useCallback(async () => {
    if (!trip) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await tripSharesApi.create({
        title: trip.name || "Untitled trip",
        snapshot: trip as unknown as Record<string, unknown>,
      });
      setShare(data);
    } catch (err) {
      // ApiError exposes status/body; anything else is already a plain Error
      // message we can show.
      const message =
        err instanceof ApiError
          ? (err.message ?? `Failed (${err.status})`)
          : err instanceof Error
            ? err.message
            : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [trip]);

  const handleCopy = useCallback(async () => {
    if (!share) return;
    const url = buildInviteUrl(share.share_token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Copy failed — select the URL manually.");
    }
  }, [share]);

  if (!open) return null;

  const inviteUrl = share ? buildInviteUrl(share.share_token) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trip-collaborate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl shadow-black/40"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2
              id="trip-collaborate-title"
              className="text-lg font-semibold text-white"
            >
              Invite your group
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Generate a read-only link that anyone can open — no account
              required to view.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X size={16} />
          </button>
        </div>

        {!trip && (
          <p className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-400">
            Generate or load a trip first to create an invite link.
          </p>
        )}

        {trip && !share && (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-tarmoto-cyan/10 px-4 py-2.5 text-sm font-medium text-tarmoto-cyan hover:bg-tarmoto-cyan/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <LinkIcon size={14} />
                Create invite link
              </>
            )}
          </button>
        )}

        {trip && share && inviteUrl && (
          <div className="space-y-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Invite link
            </label>
            <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60">
              <input
                readOnly
                value={inviteUrl}
                aria-label="Shareable invite URL"
                className="flex-1 bg-transparent px-3 py-2 text-sm text-slate-200 outline-none"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1.5 border-l border-slate-800 px-3 text-sm text-slate-300 hover:bg-slate-800 transition"
              >
                {copied ? (
                  <>
                    <Check size={14} className="text-tarmoto-cyan" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={14} />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Anyone with the link can view the trip. Editing, voting, and
              real-time collaboration are coming in follow-up releases.
            </p>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function buildInviteUrl(token: string): string {
  if (typeof window === "undefined") return `/trips/shared/${token}`;
  return `${window.location.origin}/trips/shared/${token}`;
}
