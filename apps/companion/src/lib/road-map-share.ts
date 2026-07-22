import { getUserFacingErrorMessage, t } from "@/i18n";
import { mapSharesApi } from "@/lib/api";
import { toast } from "@/lib/toast";

/**
 * Create a `map_shares` row and deliver its link via the Web Share sheet, with
 * a clipboard fallback, rolling the row back if delivery fails so cancelled
 * attempts don't accumulate orphaned rows.
 *
 * Feedback is a toast (unified with the ride-detail / community share):
 * `toast.success("Link copied")` for the clipboard path — the native share
 * sheet is its own confirmation — and `toast.error(...)` on failure. A
 * user-cancelled Web Share (AbortError) is silent.
 */
export async function shareRoadMap(
  title: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  // Capability check first: with neither Web Share nor the async Clipboard
  // API there's no way to hand the URL back, so bail BEFORE persisting and
  // orphaning a row for a browser we can't deliver to.
  const canWebShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const canClipboard =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText);
  if (!canWebShare && !canClipboard) {
    toast.error(
      t(
        "Your browser doesn't support sharing or clipboard access — try a different browser.",
      ),
    );
    return;
  }

  let createdShareId: string | null = null;
  try {
    const { data } = await mapSharesApi.create({ title, snapshot });
    createdShareId = data.id;
    const fullUrl =
      typeof window !== "undefined"
        ? new URL(data.share_url, window.location.origin).toString()
        : data.share_url;
    const shareData: ShareData = {
      title,
      text: "Check out the roads I've ridden on Tarmoto.",
      url: fullUrl,
    };
    if (canWebShare && (!navigator.canShare || navigator.canShare(shareData))) {
      // The native share sheet is its own confirmation — no toast needed.
      await navigator.share(shareData);
    } else if (canClipboard) {
      await navigator.clipboard.writeText(fullUrl);
      toast.success(t("Link copied"));
    } else {
      // Defensive: the capability check guarantees one path is available, but
      // if `canShare` rejects the payload we still need a fallback error.
      throw new Error("Sharing is not supported");
    }
    // Delivery succeeded — clear the rollback marker so the catch branch below
    // doesn't revoke a share the user actually used.
    createdShareId = null;
  } catch (err) {
    if (createdShareId) {
      void mapSharesApi.revoke(createdShareId).catch(() => undefined);
    }
    // A user-cancelled Web Share rejects with AbortError on iOS Safari — the
    // user opted out, so no error toast.
    if (!(err instanceof Error && err.name === "AbortError")) {
      toast.error(
        getUserFacingErrorMessage(err, t("Could not generate share link")),
      );
    }
  }
}
