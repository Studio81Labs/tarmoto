"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bike as BikeIcon,
  Check,
  Loader2,
  Pencil,
  Plus,
  Smartphone,
  Star,
  Trash2,
} from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { Bike } from "@/lib/types";
import { BikeFormModal } from "@/components/BikeFormModal";
import { formatBikeTitle, type BikeFormPayload } from "@/lib/bikes";
type ModalState =
  | {
      kind: "closed";
    }
  | {
      kind: "add";
    }
  | {
      kind: "edit";
      bike: Bike;
    };
type ListError = {
  kind: "load" | "action";
  message: string;
} | null;
export default function BikesPage() {
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ListError>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const [pendingActionBikeId, setPendingActionBikeId] = useState<string | null>(
    null,
  );
  const refresh = useCallback(async () => {
    try {
      const { data } = await accountApi.getBikes();
      setBikes(((data as unknown as Bike[]) ?? []).slice());
      // A successful refresh supersedes any prior error (load or action),
      // so the banner doesn't linger after the user's latest action succeeds.
      setError(null);
    } catch (err) {
      setError({
        kind: "load",
        message:
          err instanceof Error ? err.message : "Could not load your bikes",
      });
    }
  }, []);
  // Wait for the auth store to carry a token before fetching — same
  // hard-navigation race fix as the other settings pages.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    accountApi
      .getBikes()
      .then(({ data }) => {
        if (cancelled) return;
        setBikes((data as unknown as Bike[]) ?? []);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError({ kind: "load", message: err.message });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady]);
  const sortedBikes = useMemo(
    () =>
      [...bikes].sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.year - a.year;
      }),
    [bikes],
  );
  async function handleSubmit(payload: BikeFormPayload) {
    if (modal.kind === "add") {
      await accountApi.addBike(payload);
    } else if (modal.kind === "edit") {
      await accountApi.updateBike(modal.bike.id, payload);
    }
    await refresh();
  }
  async function handleSetActive(bike: Bike) {
    if (bike.isActive || pendingActionBikeId) return;
    setPendingActionBikeId(bike.id);
    // Capture the id of whatever was active before, so a rollback can restore
    // exactly the two flags we touched without snapshotting the whole list —
    // modal submits aren't blocked by pendingActionBikeId and can mutate
    // `bikes` concurrently.
    const previousActiveId = bikes.find((b) => b.isActive)?.id ?? null;
    setBikes((list) => list.map((b) => ({ ...b, isActive: b.id === bike.id })));
    try {
      await accountApi.updateBike(bike.id, { is_active: true });
      await refresh();
    } catch (err) {
      // Functional revert: flip only the two affected bikes' isActive flags,
      // so any concurrent additions/edits that landed mid-request survive.
      setBikes((list) =>
        list.map((b) => {
          if (b.id === bike.id) return { ...b, isActive: false };
          if (previousActiveId && b.id === previousActiveId)
            return { ...b, isActive: true };
          return b;
        }),
      );
      setError({
        kind: "action",
        message:
          err instanceof Error ? err.message : "Could not set active bike",
      });
    } finally {
      setPendingActionBikeId(null);
    }
  }
  async function handleDelete(bike: Bike) {
    if (pendingActionBikeId) return;
    const confirmed = window.confirm(
      `Remove ${formatBikeTitle(bike)} from your garage? Rides already recorded with this bike will be kept.`,
    );
    if (!confirmed) return;
    setPendingActionBikeId(bike.id);
    try {
      await accountApi.deleteBike(bike.id);
      await refresh();
    } catch (err) {
      setError({
        kind: "action",
        message: err instanceof Error ? err.message : "Could not delete bike",
      });
    } finally {
      setPendingActionBikeId(null);
    }
  }
  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white mb-4 transition"
      >
        <ArrowLeft size={16} />
        {t("Settings ")}
      </Link>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold">{t("My Bikes")}</h1>
        <button
          type="button"
          onClick={() => setModal({ kind: "add" })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
        >
          <Plus size={16} />
          {t("Add bike ")}
        </button>
      </div>
      <p className="text-sm text-slate-400 mb-6 inline-flex items-center gap-1.5">
        <Smartphone size={14} />
        {t("Your garage is synced with the Tarmoto mobile app. ")}
      </p>

      {error?.kind === "action" && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error.message}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl bg-slate-900 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      ) : error?.kind === "load" ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
          {error.message}
        </div>
      ) : sortedBikes.length === 0 ? (
        <EmptyState onAdd={() => setModal({ kind: "add" })} />
      ) : (
        <ul className="space-y-3">
          {sortedBikes.map((bike) => (
            <BikeCard
              key={bike.id}
              bike={bike}
              pending={pendingActionBikeId === bike.id}
              onEdit={() => setModal({ kind: "edit", bike })}
              onDelete={() => handleDelete(bike)}
              onSetActive={() => handleSetActive(bike)}
            />
          ))}
        </ul>
      )}

      <BikeFormModal
        open={modal.kind !== "closed"}
        mode={modal.kind === "edit" ? "edit" : "add"}
        initialBike={modal.kind === "edit" ? modal.bike : undefined}
        onClose={() => setModal({ kind: "closed" })}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
interface BikeCardProps {
  bike: Bike;
  pending: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetActive: () => void;
}
function BikeCard({
  bike,
  pending,
  onEdit,
  onDelete,
  onSetActive,
}: BikeCardProps) {
  const ridesLabel =
    typeof bike.totalRides === "number"
      ? `${bike.totalRides.toLocaleString()} ride${bike.totalRides === 1 ? "" : "s"}`
      : null;
  return (
    <li className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-xl bg-slate-900 border border-slate-800">
      <div className="w-20 h-20 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden flex-shrink-0">
        {bike.photoUrl ? (
          // Plain <img> is fine — these are small user uploads shown once per
          // card; next/image adds little value and would need remotePatterns
          // for arbitrary user URLs.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bike.photoUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <BikeIcon size={28} className="text-slate-500" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-medium text-white truncate">
            {formatBikeTitle(bike)}
          </p>
          {bike.isActive && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-tarmoto-cyan/10 text-tarmoto-cyan text-xs font-medium">
              <Check size={12} />
              {t("Active ")}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-400 mt-0.5">
          {bike.year} • {bike.totalKm.toLocaleString()}
          {t("km ")}
          {ridesLabel ? ` • ${ridesLabel}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        {!bike.isActive && (
          <button
            type="button"
            onClick={onSetActive}
            disabled={pending}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-300 hover:text-tarmoto-cyan hover:bg-slate-800 transition disabled:opacity-50"
            aria-label={`Set ${formatBikeTitle(bike)} as active`}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Star size={14} />
            )}
            {t("Set active ")}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          disabled={pending}
          className="p-2 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition disabled:opacity-50"
          aria-label={`Edit ${formatBikeTitle(bike)}`}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="p-2 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-800 transition disabled:opacity-50"
          aria-label={`Delete ${formatBikeTitle(bike)}`}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-12 text-center">
      <BikeIcon size={48} className="mx-auto text-slate-600 mb-4" />
      <p className="text-slate-300 mb-2 font-medium">
        {t("No bikes in your garage yet ")}
      </p>
      <p className="text-slate-500 text-sm mb-5">
        {t(
          "Add your motorcycle to get bike-specific stats and recommendations. ",
        )}
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition"
      >
        <Plus size={16} />
        {t("Add your first bike ")}
      </button>
    </div>
  );
}
