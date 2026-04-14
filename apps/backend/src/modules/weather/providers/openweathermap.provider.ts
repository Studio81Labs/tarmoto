import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WeatherProvider,
  WeatherData,
} from '../weather-provider.interface.js';
import type { WeatherCondition, RoadCondition } from '../dto/weather.dto.js';

interface OWMResponse {
  main: { temp: number; humidity: number };
  weather: Array<{ id: number; main: string; description: string }>;
  wind: { speed: number };
  rain?: { '1h'?: number };
  snow?: { '1h'?: number };
  clouds: { all: number };
}

/**
 * OpenWeatherMap implementation of WeatherProvider.
 * Uses the Current Weather API (free tier: 1000 calls/day).
 * Swap this out by providing a different WEATHER_PROVIDER implementation.
 */
@Injectable()
export class OpenWeatherMapProvider implements WeatherProvider {
  private readonly logger = new Logger(OpenWeatherMapProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.openweathermap.org/data/2.5';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('TARMOTO_OWM_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn(
        'TARMOTO_OWM_API_KEY not set — weather requests will fail',
      );
    }
  }

  async getCurrentWeather(lat: number, lng: number): Promise<WeatherData> {
    const url =
      `${this.baseUrl}/weather?lat=${lat}&lon=${lng}` +
      `&appid=${this.apiKey}&units=metric`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `OpenWeatherMap API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OWMResponse;
    return this.normalize(data);
  }

  private normalize(data: OWMResponse): WeatherData {
    const weather = data.weather[0];
    const condition = this.mapCondition(weather?.id ?? 800);
    const precipChance = this.estimatePrecipChance(data);
    const roadCondition = this.inferRoadCondition(
      condition,
      data.main.temp,
      data.rain?.['1h'],
      data.snow?.['1h'],
    );

    return {
      temperature_c: Math.round(data.main.temp * 10) / 10,
      condition,
      wind_kmh: Math.round(data.wind.speed * 3.6 * 10) / 10,
      precipitation_chance: precipChance,
      road_condition: roadCondition,
    };
  }

  /**
   * Map OWM weather condition codes to our enum.
   * https://openweathermap.org/weather-conditions
   */
  private mapCondition(code: number): WeatherCondition {
    if (code >= 200 && code < 300) return 'storm'; // thunderstorm
    if (code >= 300 && code < 400) return 'rain'; // drizzle
    if (code >= 500 && code < 600) return 'rain';
    if (code >= 600 && code < 700) return 'snow';
    // 7xx: atmosphere — squall (771) and tornado (781) are storms, rest is fog
    if (code === 771 || code === 781) return 'storm';
    if (code >= 700 && code < 800) return 'fog'; // mist, haze, dust, smoke
    if (code === 800) return 'clear';
    if (code > 800) return 'cloudy';
    return 'clear';
  }

  /**
   * Estimate precipitation probability from available data.
   * OWM free tier doesn't include pop; we estimate from rain/cloud data.
   */
  private estimatePrecipChance(data: OWMResponse): number {
    const rain1h = data.rain?.['1h'] ?? 0;
    const snow1h = data.snow?.['1h'] ?? 0;
    if (rain1h > 0 || snow1h > 0) return 1.0;

    const cloudCover = data.clouds.all / 100;
    if (cloudCover > 0.8) return 0.4;
    if (cloudCover > 0.5) return 0.2;
    return 0;
  }

  /**
   * Infer road surface condition from weather + temperature.
   */
  private inferRoadCondition(
    condition: WeatherCondition,
    tempC: number,
    rainMm?: number,
    snowMm?: number,
  ): RoadCondition {
    if (snowMm && snowMm > 0) return 'icy';
    if (condition === 'snow' || condition === 'ice') return 'icy';
    if (tempC <= 0 && (condition === 'rain' || (rainMm && rainMm > 0)))
      return 'icy';
    if (tempC < 2 && condition === 'fog') return 'icy';
    if (condition === 'rain' || condition === 'storm') return 'wet';
    if (rainMm && rainMm > 0) return 'wet';
    if (condition === 'clear' || condition === 'cloudy' || condition === 'fog')
      return 'dry';
    return 'unknown';
  }
}
