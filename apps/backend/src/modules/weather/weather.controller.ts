import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WeatherService } from './weather.service.js';
import {
  WeatherQueryDto,
  RouteWeatherDto,
  WeatherResponseDto,
  RouteWeatherResponseDto,
} from './dto/weather.dto.js';

@ApiTags('weather')
@Controller('weather')
export class WeatherController {
  constructor(private readonly weatherService: WeatherService) {}

  @Get('current')
  @ApiOperation({ summary: 'Get current weather at a location' })
  @ApiResponse({ status: 200, type: WeatherResponseDto })
  async getCurrent(
    @Query() query: WeatherQueryDto,
  ): Promise<WeatherResponseDto> {
    return this.weatherService.getCurrentWeather(query.lat, query.lng);
  }

  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get weather conditions along a route',
    description:
      'Samples weather every ~20km along the route and returns conditions ' +
      'at each point plus alerts for dangerous conditions (rain, ice, storms, wind).',
  })
  @ApiResponse({ status: 200, type: RouteWeatherResponseDto })
  async getRouteWeather(
    @Body() dto: RouteWeatherDto,
  ): Promise<RouteWeatherResponseDto> {
    return this.weatherService.getRouteWeather(dto.route);
  }
}
