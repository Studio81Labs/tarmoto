import type { WeatherCondition, RoadCondition } from './dto/weather.dto.js';

/**
 * Normalized weather data returned by any provider.
 * All providers must map their API response to this shape.
 */
export interface WeatherData {
  temperature_c: number;
  condition: WeatherCondition;
  wind_kmh: number;
  precipitation_chance: number;
  road_condition: RoadCondition;
  /** Raw description from provider (e.g. "light rain") */
  provider_description: string;
}

/**
 * Abstract weather provider interface.
 * Implement this to add a new weather service (OpenWeatherMap, Tomorrow.io, etc.)
 */
export interface WeatherProvider {
  /**
   * Get current weather at a location.
   */
  getCurrentWeather(lat: number, lng: number): Promise<WeatherData>;
}

/**
 * Injection token for the weather provider.
 * Use this in module configuration to swap implementations.
 */
export const WEATHER_PROVIDER = 'WEATHER_PROVIDER';
