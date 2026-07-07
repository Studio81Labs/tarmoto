import type { components } from "@tarmoto/openapi-client";
import { tripFromDetail } from "@/lib/trip-from-detail";
import type { Trip, TripParameters } from "@/lib/types";

export type TripGenerationOptionResponse =
  components["schemas"]["TripGenerationOptionDto"];
export type GenerateTripResponse =
  components["schemas"]["GenerateTripResponseDto"];
export type TripGenerationOptionId = GenerateTripResponse["selected_option"];

/** View model for a generated trip option — carries the camelCase `Trip`. */
export interface GeneratedTripOption {
  id: TripGenerationOptionId;
  label: string;
  summary: string;
  trip: Trip;
  selected: boolean;
}

export function generatedOptionsFromResponse(
  response: GenerateTripResponse,
  requestParameters?: TripParameters,
): GeneratedTripOption[] {
  return response.options.map((option) => ({
    id: option.id,
    label: option.label,
    summary: option.summary,
    selected: option.selected,
    trip: withRequestParameters(
      tripFromDetail(
        option.selected
          ? response.trip
          : {
              ...response.trip,
              id: `${response.trip.id}:${option.id}`,
              status: response.trip.status || "planned",
              days: option.days,
            },
      ),
      requestParameters,
    ),
  }));
}

function withRequestParameters(
  trip: Trip,
  requestParameters: TripParameters | undefined,
): Trip {
  return requestParameters
    ? {
        ...trip,
        parameters: {
          ...requestParameters,
          surfacePreference: [...requestParameters.surfacePreference],
        },
      }
    : trip;
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
