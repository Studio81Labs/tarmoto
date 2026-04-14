import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WEATHER_PROVIDER } from './weather-provider.interface.js';
import { OpenWeatherMapProvider } from './providers/openweathermap.provider.js';
import { WeatherController } from './weather.controller.js';
import { WeatherService } from './weather.service.js';

/**
 * Weather module with pluggable provider.
 * To switch from OpenWeatherMap to another service (e.g. Tomorrow.io),
 * create a new provider implementing WeatherProvider and replace
 * the WEATHER_PROVIDER useClass below.
 */
@Module({
  imports: [ConfigModule],
  controllers: [WeatherController],
  providers: [
    { provide: WEATHER_PROVIDER, useClass: OpenWeatherMapProvider },
    WeatherService,
  ],
  exports: [WeatherService],
})
export class WeatherModule {}
