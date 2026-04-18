import type { Bike } from "@/lib/types";

export interface BikeFormValues {
  make: string;
  model: string;
  year: string;
  photoUrl: string;
}

export interface BikeFormPayload {
  make: string;
  model: string;
  year: number;
  photoUrl: string | null;
}

export type BikeFormErrors = Partial<Record<keyof BikeFormValues, string>>;

// Bikes older than 1900 and newer than "next model year" are almost certainly
// typos. We allow currentYear+1 because manufacturers release next-year models
// mid-season.
export const MIN_BIKE_YEAR = 1900;

export function maxBikeYear(now: Date = new Date()): number {
  return now.getFullYear() + 1;
}

export const EMPTY_BIKE_FORM: BikeFormValues = {
  make: "",
  model: "",
  year: "",
  photoUrl: "",
};

export function bikeToFormValues(bike: Bike): BikeFormValues {
  return {
    make: bike.make,
    model: bike.model,
    year: String(bike.year),
    photoUrl: bike.photoUrl ?? "",
  };
}

export function validateBikeForm(
  values: BikeFormValues,
  now: Date = new Date(),
): BikeFormErrors {
  const errors: BikeFormErrors = {};

  if (!values.make.trim()) errors.make = "Make is required";
  if (!values.model.trim()) errors.model = "Model is required";

  const yearTrimmed = values.year.trim();
  if (!yearTrimmed) {
    errors.year = "Year is required";
  } else if (!/^\d{4}$/.test(yearTrimmed)) {
    errors.year = "Enter a 4-digit year";
  } else {
    const year = Number(yearTrimmed);
    const max = maxBikeYear(now);
    if (year < MIN_BIKE_YEAR || year > max) {
      errors.year = `Year must be between ${MIN_BIKE_YEAR} and ${max}`;
    }
  }

  const photo = values.photoUrl.trim();
  if (photo && !isHttpUrl(photo)) {
    errors.photoUrl = "Photo URL must start with http:// or https://";
  }

  return errors;
}

// The form accepts strings but the API wants a typed payload. Callers must
// ensure `validateBikeForm` returned no errors before calling this.
export function formValuesToPayload(values: BikeFormValues): BikeFormPayload {
  const photo = values.photoUrl.trim();
  return {
    make: values.make.trim(),
    model: values.model.trim(),
    year: Number(values.year.trim()),
    photoUrl: photo ? photo : null,
  };
}

export function hasErrors(errors: BikeFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function formatBikeTitle(bike: Pick<Bike, "make" | "model">): string {
  return `${bike.make} ${bike.model}`.trim();
}
