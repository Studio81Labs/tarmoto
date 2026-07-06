"use client";
import { t } from "@/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bike as BikeIcon, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { Bike } from "@/lib/types";
import { BikeFormModal } from "@/components/BikeFormModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatBikeTitle, type BikeFormPayload } from "@/lib/bikes";
import { Button, Card, Pill } from "@tarmoto/ui";
import { SettingsSubpageHeader } from "../_SettingsSubpageHeader";
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
  // Delete confirms through the app dialog — system dialogs are disallowed.
  const [confirmDeleteBike, setConfirmDeleteBike] = useState<Bike | null>(null);
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
    setConfirmDeleteBike(null);
    if (pendingActionBikeId) return;
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
    <div className="mx-auto w-full max-w-page animate-fade-in p-4 md:p-7">
      <SettingsSubpageHeader
        stamp={t("Settings · Garage")}
        icon={<BikeIcon size={18} strokeWidth={2} />}
        title={t("My Bikes")}
        sub={t("Each ride attaches to whichever bike is active at the time.")}
        right={
          <Button
            variant="accent"
            uppercase
            leftIcon={<Plus size={14} />}
            onClick={() => setModal({ kind: "add" })}
          >
            {t("Add bike")}
          </Button>
        }
      />
      {error?.kind === "action" && (
        <div className="mb-4 rounded-xl border border-quality-q1/30 bg-quality-q1/10 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {loading ? (
        <div className="space-y-2.5">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-[88px] animate-pulse rounded-[14px] border border-line bg-paper"
            />
          ))}
        </div>
      ) : error?.kind === "load" ? (
        <div className="rounded-xl border border-quality-q1/30 bg-quality-q1/10 p-5 text-sm text-red-400">
          {error.message}
        </div>
      ) : sortedBikes.length === 0 ? (
        <EmptyState onAdd={() => setModal({ kind: "add" })} />
      ) : (
        <ul className="space-y-2.5">
          {sortedBikes.map((bike) => (
            <BikeRow
              key={bike.id}
              bike={bike}
              pending={pendingActionBikeId === bike.id}
              onEdit={() => setModal({ kind: "edit", bike })}
              onDelete={() => setConfirmDeleteBike(bike)}
              onSetActive={() => handleSetActive(bike)}
            />
          ))}
        </ul>
      )}

      <BikeFormModal
        open={modal.kind !== "closed"}
        mode={modal.kind === "edit" ? "edit" : "add"}
        {...(modal.kind === "edit" ? { initialBike: modal.bike } : {})}
        onClose={() => setModal({ kind: "closed" })}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={confirmDeleteBike !== null}
        title={t("Remove this bike?")}
        message={
          confirmDeleteBike
            ? t(
                "{bike} is removed from your garage. Rides already recorded with it are kept. ",
                { bike: formatBikeTitle(confirmDeleteBike) },
              )
            : ""
        }
        tone="danger"
        confirmLabel={t("Remove bike")}
        onCancel={() => setConfirmDeleteBike(null)}
        onConfirm={() => {
          if (confirmDeleteBike) void handleDelete(confirmDeleteBike);
        }}
      />
    </div>
  );
}

interface BikeRowProps {
  bike: Bike;
  pending: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetActive: () => void;
}

// Active bikes get the ink/cream-typed treatment per spec — the "one
// active bike" rule reads better when the active row visually owns the
// list. Inactive rows stay cream-on-paper with a hairline border.
function BikeRow({
  bike,
  pending,
  onEdit,
  onDelete,
  onSetActive,
}: BikeRowProps) {
  const isActive = bike.isActive;
  const ridesLabel =
    typeof bike.totalRides === "number"
      ? `${bike.totalRides.toLocaleString()} ride${bike.totalRides === 1 ? "" : "s"}`
      : null;
  return (
    <li
      className={
        isActive
          ? "flex flex-col items-stretch gap-4 rounded-[14px] border border-ink bg-ink p-4 text-cream sm:flex-row sm:items-center"
          : "flex flex-col items-stretch gap-4 rounded-[14px] border border-line bg-cream p-4 text-ink sm:flex-row sm:items-center"
      }
    >
      <div
        className={
          isActive
            ? "flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-cream/10"
            : "flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-paper"
        }
      >
        {bike.photoUrl ? (
          // Plain <img> is fine — these are small user uploads shown once per
          // row; next/image adds little value and would need remotePatterns
          // for arbitrary user URLs.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bike.photoUrl} alt="" className="size-full object-cover" />
        ) : (
          <BikeIcon
            size={26}
            strokeWidth={1.8}
            className={isActive ? "text-cream" : "text-ink"}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p
          className={
            isActive
              ? "truncate text-[16px] font-extrabold leading-tight text-cream"
              : "truncate text-[16px] font-extrabold leading-tight text-ink"
          }
        >
          {formatBikeTitle(bike)}
        </p>
        <p
          className={
            isActive
              ? "mt-1 text-[12px] text-cream/65"
              : "mt-1 text-[12px] text-fg-dim"
          }
        >
          {bike.year} · {bike.totalKm.toLocaleString()}
          {t("km ")}
          {ridesLabel ? ` · ${ridesLabel}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        {isActive ? (
          <Pill variant="accent">{t("Active ")}</Pill>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            uppercase
            loading={pending}
            leftIcon={<Star size={12} />}
            onClick={onSetActive}
            aria-label={`Set ${formatBikeTitle(bike)} as active`}
          >
            {t("Make active")}
          </Button>
        )}
        <button
          type="button"
          onClick={onEdit}
          disabled={pending}
          className={
            isActive
              ? "rounded-md p-2 text-cream/65 transition hover:bg-cream/10 hover:text-cream disabled:opacity-50"
              : "rounded-md p-2 text-fg-dim transition hover:bg-paper hover:text-ink disabled:opacity-50"
          }
          aria-label={`Edit ${formatBikeTitle(bike)}`}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className={
            isActive
              ? "rounded-md p-2 text-cream/65 transition hover:bg-cream/10 hover:text-quality-q1 disabled:opacity-50"
              : "rounded-md p-2 text-fg-dim transition hover:bg-paper hover:text-quality-q1 disabled:opacity-50"
          }
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
    <Card padded={false}>
      <div className="px-5 py-12 text-center">
        <BikeIcon
          size={48}
          className="mx-auto mb-4 text-fg-mute"
          strokeWidth={1.5}
        />
        <p className="mb-2 font-semibold text-ink">
          {t("No bikes in your garage yet ")}
        </p>
        <p className="mx-auto mb-5 max-w-sm text-[13px] text-fg-dim">
          {t(
            "Add your motorcycle to get bike-specific stats and recommendations. ",
          )}
        </p>
        <Button
          variant="accent"
          uppercase
          leftIcon={<Plus size={16} />}
          onClick={onAdd}
        >
          {t("Add your first bike ")}
        </Button>
      </div>
    </Card>
  );
}
