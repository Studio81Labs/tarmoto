import { create } from "zustand";
import type { ManeuverType } from "@/services/navigation";
import type { LatLng } from "@/types";

export interface VehicleRideStats {
  rideType: "free" | "commute" | "trip";
  speedKmh: number;
  distanceKm: number;
  durationSeconds: number;
}

export interface VehicleDisplaySnapshot {
  title: string;
  polyline: LatLng[];
  currentLocation: LatLng | null;
  nextManeuver: {
    type: ManeuverType;
    roadName?: string;
  } | null;
  distanceToNextM: number;
  remainingM: number;
  offRoute: boolean;
  offRouteDistanceM: number;
  rideStats: VehicleRideStats;
  banner: { message: string; tone: "success" | "danger" } | null;
}

interface VehicleDisplayState {
  visible: boolean;
  snapshot: VehicleDisplaySnapshot | null;
  setVisible: (visible: boolean) => void;
  setSnapshot: (snapshot: VehicleDisplaySnapshot | null) => void;
  setBanner: (banner: VehicleDisplaySnapshot["banner"]) => void;
}

export const useVehicleDisplayStore = create<VehicleDisplayState>((set) => ({
  visible: false,
  snapshot: null,
  setVisible: (visible) => set({ visible }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setBanner: (banner) =>
    set((state) => ({
      snapshot: state.snapshot ? { ...state.snapshot, banner } : state.snapshot,
    })),
}));
