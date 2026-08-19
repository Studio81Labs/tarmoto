/**
 * Unit conversion utilities.
 *
 * Convention: Backend stores and serves all values in metric.
 * Clients convert for display based on user preference.
 */

export type UnitSystem = "metric" | "imperial";

// ── Temperature ──

export function celsiusToFahrenheit(c: number): number {
  return Math.round(((c * 9) / 5 + 32) * 10) / 10;
}

export function fahrenheitToCelsius(f: number): number {
  return Math.round((((f - 32) * 5) / 9) * 10) / 10;
}

// ── Distance ──

export function kmToMiles(km: number): number {
  return Math.round(km * 0.621371 * 100) / 100;
}

export function milesToKm(mi: number): number {
  return Math.round(mi * 1.60934 * 100) / 100;
}

export function metersToFeet(m: number): number {
  return Math.round(m * 3.28084);
}

export function feetToMeters(ft: number): number {
  return Math.round(ft * 0.3048 * 100) / 100;
}

// ── Speed ──

export function kmhToMph(kmh: number): number {
  return Math.round(kmh * 0.621371 * 10) / 10;
}

export function mphToKmh(mph: number): number {
  return Math.round(mph * 1.60934 * 10) / 10;
}

// ── Formatters ──

export function formatDistance(km: number, units: UnitSystem): string {
  if (units === "imperial") {
    const mi = kmToMiles(km);
    return `${mi} mi`;
  }
  return `${km} km`;
}

export function formatSpeed(kmh: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${kmhToMph(kmh)} mph`;
  }
  return `${kmh} km/h`;
}

export function formatTemperature(c: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${celsiusToFahrenheit(c)}°F`;
  }
  return `${c}°C`;
}

export function formatElevation(m: number, units: UnitSystem): string {
  if (units === "imperial") {
    return `${metersToFeet(m)} ft`;
  }
  return `${m} m`;
}
