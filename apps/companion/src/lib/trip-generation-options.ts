import {
  tripFromDetail,
  type TripDetailDay,
  type TripDetailResponse,
} from "@/lib/trip-from-detail";
import type { Trip } from "@/lib/types";

export type TripGenerationOptionId = "best-fit" | "scenic" | "fastest";

export interface GeneratedTripOption {
  id: TripGenerationOptionId;
  label: string;
  summary: string;
  trip: Trip;
  selected: boolean;
}

export interface TripGenerationOptionResponse {
  id: TripGenerationOptionId;
  label: string;
  summary: string;
  total_distance_km: number;
  total_duration_min: number;
  avg_quality: number;
  avg_curviness: number;
  avg_scenic: number;
  selected: boolean;
  days: TripDetailDay[];
}

export interface GenerateTripResponse {
  trip: TripDetailResponse;
  selected_option: TripGenerationOptionId;
  options: TripGenerationOptionResponse[];
}

export function generatedOptionsFromResponse(
  response: GenerateTripResponse,
): GeneratedTripOption[] {
  return response.options.map((option) => ({
    id: option.id,
    label: option.label,
    summary: option.summary,
    selected: option.selected,
    trip: tripFromDetail(
      option.selected
        ? response.trip
        : {
            ...response.trip,
            id: `${response.trip.id}:${option.id}`,
            status: response.trip.status || "planned",
            days: option.days,
          },
    ),
  }));
}

export function selectedGeneratedOption(
  options: GeneratedTripOption[],
  selectedOptionId: string | null,
): GeneratedTripOption | null {
  return (
    options.find((option) => option.id === selectedOptionId) ??
    options.find((option) => option.selected) ??
    options[0] ??
    null
  );
}
