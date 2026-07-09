"use client";
import { t } from "@/i18n";
import {
  Bike,
  Coffee,
  Eye,
  Fuel,
  Mountain,
  MountainSnow,
  Route,
  Tent,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { GeocodeSearchField } from "@/components/planner/GeocodeSearchField";
import type { GeoResult, PoiCategory } from "@/lib/planner/types";
import { useTripStore } from "@/stores/trip";

/**
 * Map-top toolbar (revision 4 §C): address search + the multi-select POI
 * category bar. The chips toggle the SAME `activePoiCategories` store
 * slice the STOPS-tab filters read — one source of truth (§A). Curated
 * set only; deliberately no generic POI browser.
 */
export const POI_CATEGORY_META: ReadonlyArray<{
  category: PoiCategory;
  label: string;
  icon: LucideIcon;
}> = [
  { category: "fuel", label: "Fuel", icon: Fuel },
  { category: "food", label: "Food & drinks", icon: UtensilsCrossed },
  { category: "cafe", label: "Cafes", icon: Coffee },
  { category: "viewpoint", label: "Sights & viewpoints", icon: Eye },
  { category: "campground", label: "Campgrounds", icon: Tent },
  { category: "biker_hotel", label: "Biker hotels", icon: Bike },
  { category: "mountain_pass", label: "Mountain passes", icon: MountainSnow },
  { category: "twisty_highlight", label: "Twisty highlights", icon: Route },
];

export function poiCategoryMeta(category: PoiCategory) {
  return (
    POI_CATEGORY_META.find((entry) => entry.category === category) ?? {
      category,
      label: category,
      icon: Mountain,
    }
  );
}

interface MapToolbarProps {
  /**
   * Called with a picked geocode result — the map flies there and opens
   * the placement menu (start / via / finish); nothing is placed yet.
   */
  onPlace: (result: GeoResult) => void;
}

export function MapToolbar({ onPlace }: MapToolbarProps) {
  const activePoiCategories = useTripStore((s) => s.activePoiCategories);
  const togglePoiCategory = useTripStore((s) => s.togglePoiCategory);

  return (
    // z-30: the search dropdown must paint over the basemap/draw cluster
    // below (both control groups share the map's overlay plane).
    // right-14 keeps the chip row clear of MapLibre's +/- zoom controls
    // in the map's top-right corner.
    <div className="absolute left-3 right-14 top-3 z-30 flex items-center gap-2">
      <div className="relative w-[240px] shrink-0 rounded-[10px] border border-line-strong bg-cream/95 px-3 py-2 shadow-[0_4px_12px_rgba(14,14,16,0.10)]">
        <GeocodeSearchField
          placeholder={t("Address search ")}
          ariaLabel={t("Address search")}
          onSelect={onPlace}
          clearOnSelect
          widenDropdown
          clearable
        />
      </div>
      <div
        role="group"
        aria-label={t("POI categories")}
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5"
      >
        {POI_CATEGORY_META.map(({ category, label, icon: Icon }) => {
          const active = activePoiCategories.has(category);
          return (
            <button
              key={category}
              type="button"
              aria-pressed={active}
              onClick={() => togglePoiCategory(category)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold transition ${
                active
                  ? "border-accent bg-accent text-cream"
                  : "border-line-strong bg-cream/90 text-ink hover:border-ink"
              }`}
            >
              <Icon size={13} />
              {t(label)}
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full border ${
                  active ? "border-cream bg-cream/20" : "border-line-strong"
                }`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
