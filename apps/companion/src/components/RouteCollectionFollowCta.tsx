"use client";
import { t } from "@/i18n";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, Loader2 } from "lucide-react";
import { ApiError, routeCollectionsApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { COLLECTIONS_LIBRARY_QUERY_PREFIX } from "@/hooks/useCollections";
interface Props {
  collectionId: string;
  slug: string;
  /**
   * The owner's display name, used in the signed-out CTA copy ("Sign in to
   * follow Jane Rider"). Falls back to the generic copy when empty.
   */
  ownerName: string;
}
type ViewerState =
  | {
      kind: "loading";
    }
  | {
      kind: "anonymous";
    }
  | {
      kind: "owner";
    }
  | {
      kind: "viewer";
      isFollowing: boolean;
    };
/**
 * Follow / unfollow CTA on the public collection page (US-56 follow/save).
 *
 * The slug page is server-rendered without a Bearer token, so the SSR pass
 * cannot personalise the response. Once the auth store hydrates we re-fetch
 * the slug client-side — the backend's optional-auth guard then populates
 * `viewer_is_owner` and `viewer_is_following` from the access token.
 *
 * Branches:
 *  - Signed out → sign-in link.
 *  - Signed-in owner → "manage from dashboard" link, no toggle.
 *  - Signed-in non-owner → Follow / Following toggle.
 */
export function RouteCollectionFollowCta({
  collectionId,
  slug,
  ownerName,
}: Props) {
  const loginHref = `/login?callbackUrl=${encodeURIComponent(
    `/community/collections/shared/${encodeURIComponent(slug)}`,
  )}`;
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated) {
      setState({ kind: "anonymous" });
      return;
    }
    // Re-fetch the slug with the Bearer token attached — the SSR pass
    // returned the anonymous projection (viewer_is_owner=false,
    // viewer_is_following=false) because the server fetch wasn't authed.
    let cancelled = false;
    void routeCollectionsApi
      .getBySlug(slug)
      .then(({ data }) => {
        if (cancelled) return;
        if (data.viewer_is_owner) {
          setState({ kind: "owner" });
        } else {
          setState({
            kind: "viewer",
            isFollowing: data.viewer_is_following,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // The slug may have flipped to private / been deleted between SSR and
        // hydration. Fall back to the anonymous CTA so the user has a clear
        // next step rather than a dead button. The page-level metadata is
        // still valid because the server fetch succeeded.
        setState({ kind: "anonymous" });
      });
    return () => {
      cancelled = true;
    };
    // We intentionally re-run when the access token changes (sign-in/out
    // mid-session) so the CTA reflects the current viewer.
  }, [isAuthenticated, accessToken, slug]);
  if (state.kind === "loading") {
    return (
      <div
        aria-busy="true"
        className="h-[152px] rounded-2xl border border-slate-800 bg-slate-900 animate-pulse"
      />
    );
  }
  if (state.kind === "anonymous") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-sm font-semibold text-white mb-1">
          {t("Want to save this collection? ")}
        </h2>
        <p className="text-sm text-slate-400 mb-4">
          {t(
            "Sign in to Tarmoto to follow {collectionOwner} and add their routes to your own library.",
            {
              collectionOwner: ownerName
                ? `${ownerName}'s collection`
                : "the curator",
            },
          )}
        </p>
        <Link
          href={loginHref}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-slate-950 text-sm font-semibold hover:bg-accent transition"
        >
          {t("Sign in")}
        </Link>
      </div>
    );
  }
  if (state.kind === "owner") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-sm font-semibold text-white mb-1">
          {t("You own this collection ")}
        </h2>
        <p className="text-sm text-slate-400">
          {t("Manage routes, visibility, and sharing from")}{" "}
          <Link
            href="/community/collections"
            className="text-accent hover:text-accent underline"
          >
            {t("your dashboard ")}
          </Link>
          .
        </p>
      </div>
    );
  }
  const isFollowing = state.isFollowing;
  const onClick = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const previous = isFollowing;
    setState({ kind: "viewer", isFollowing: !previous });
    try {
      if (previous) {
        await routeCollectionsApi.unfollow(collectionId);
      } else {
        await routeCollectionsApi.follow(collectionId);
      }
      // Drop any cached `useCollections` payload across users so the
      // library page picks up the new follow/unfollow on next mount
      // instead of serving the pre-mutation snapshot for the 30s
      // shared `staleTime`.
      await queryClient.invalidateQueries({
        queryKey: COLLECTIONS_LIBRARY_QUERY_PREFIX,
      });
    } catch (err) {
      // Revert the local state so the button label matches reality and the
      // user can retry. We surface the message inline rather than via a
      // toast so it stays anchored to the action that produced it.
      setState({ kind: "viewer", isFollowing: previous });
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? "This collection is no longer available."
            : err.status === 400
              ? "You can't follow your own collection."
              : err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong.";
      setError(message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-sm font-semibold text-white mb-1">
        {isFollowing ? "Saved to your library" : "Save this collection"}
      </h2>
      <p className="text-sm text-slate-400 mb-4">
        {isFollowing
          ? "This collection appears under Followed in your dashboard. Unfollow any time to remove it."
          : "Follow to add this collection to your library and revisit it from your dashboard."}
      </p>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={pending}
        aria-pressed={isFollowing}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50 ${
          isFollowing
            ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
            : "bg-accent text-slate-950 hover:bg-accent"
        }`}
      >
        {pending ? (
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        ) : isFollowing ? (
          <BookmarkCheck size={16} aria-hidden="true" />
        ) : (
          <Bookmark size={16} aria-hidden="true" />
        )}
        {isFollowing ? "Following" : "Follow collection"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
