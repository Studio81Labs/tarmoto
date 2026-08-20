"use client";

import { useEffect, useState } from "react";
import { Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "@/i18n/I18nProvider";
import { getUserFacingErrorMessage } from "@/i18n";
import { roadsApi, type MyReviewVote } from "@/lib/api";
import { useFormat } from "@/format/FormatProvider";
import { toast } from "@/lib/toast";
import { formatRelativeTimeLabel } from "@tarmoto/shared";

/**
 * The rider's earlier helpful / not-helpful votes, each with a withdraw
 * action (#1177).
 *
 * Rendered by {@link RoadReviewsPanel} ONLY while `sys_poi_ratings` is off:
 * the backend deliberately leaves the withdrawal DELETE open during a pause
 * (a kill switch must never trap user content), but the DELETE is keyed on a
 * review id — and with every review hidden, this listing is the rider's only
 * way to obtain one. While the switch is on, the vote chips on the review
 * cards are the withdrawal affordance, so this section stays out of the way.
 *
 * The backing endpoint returns only the caller's own vote rows plus road
 * labels — no aggregate counts and nothing authored by another rider — so
 * showing it during a pause reopens none of the data the switch hides.
 */
export function MyReviewVotesSection() {
  const t = useTranslation();
  const format = useFormat();
  // null = the fetch has not settled yet; the section renders nothing rather
  // than flashing a loader for what is a secondary affordance.
  const [votes, setVotes] = useState<MyReviewVote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<ReadonlySet<string>>(
    new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    roadsApi
      .getMyReviewVotes()
      .then(({ data }) => {
        if (cancelled) return;
        setVotes(data);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          getUserFacingErrorMessage(err, t("Could not load your votes.")),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleWithdraw = async (reviewId: string) => {
    if (withdrawing.has(reviewId)) return;
    setWithdrawing((current) => new Set(current).add(reviewId));
    try {
      await roadsApi.clearReviewVote(reviewId);
      setVotes(
        (current) =>
          current?.filter((vote) => vote.review_id !== reviewId) ?? current,
      );
    } catch (err) {
      toast.error(
        getUserFacingErrorMessage(err, t("Could not withdraw your vote.")),
      );
    } finally {
      setWithdrawing((current) => {
        const next = new Set(current);
        next.delete(reviewId);
        return next;
      });
    }
  };

  if (error) {
    return (
      <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-500">
        {error}
      </div>
    );
  }
  // Nothing to withdraw (or still finding out) — say nothing rather than
  // adding an empty card under the paused notice.
  if (!votes || votes.length === 0) return null;

  return (
    <section className="mt-3 rounded-xl border border-line bg-paper p-3">
      <p className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-mute">
        {t("Your votes on community reviews")}
      </p>
      <p className="mt-1 text-xs text-fg-dim">
        {t(
          "Votes you cast earlier can still be withdrawn while reviews are paused.",
        )}
      </p>
      <ul className="mt-2 space-y-2">
        {votes.map((vote) => {
          const roadLabel =
            vote.road_name ?? vote.road_number ?? t("Unnamed road");
          const pending = withdrawing.has(vote.review_id);
          return (
            <li key={vote.review_id} className="flex items-center gap-2">
              {vote.is_helpful ? (
                <ThumbsUp
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-accent"
                />
              ) : (
                <ThumbsDown
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-accent"
                />
              )}
              <span className="sr-only">
                {vote.is_helpful ? t("Helpful vote") : t("Not-helpful vote")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-ink">
                  {roadLabel}
                </p>
                <p className="text-[11px] text-fg-mute">
                  {formatRelativeTimeLabel(vote.voted_at, { format }, t)}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => void handleWithdraw(vote.review_id)}
                aria-label={t("Withdraw your vote on {road}", {
                  road: roadLabel,
                })}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-2.5 py-1 text-xs text-fg-dim transition hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending && <Loader2 size={12} className="animate-spin" />}
                {t("Withdraw")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
