import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_ROUTE_QUALITY_POINTS,
  RouteQualityRequestDto,
} from './route-quality.dto.js';

describe('RouteQualityRequestDto geometry validation', () => {
  const point = { lat: 49.1, lng: 16.7 };

  it('accepts a minimal 2-point route', async () => {
    const dto = plainToInstance(RouteQualityRequestDto, {
      geometry: [point, point],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a geometry over the vertex cap (400) before any query is built', async () => {
    const dto = plainToInstance(RouteQualityRequestDto, {
      geometry: Array.from(
        { length: MAX_ROUTE_QUALITY_POINTS + 1 },
        () => point,
      ),
    });
    const errors = await validate(dto);
    const geometryError = errors.find((e) => e.property === 'geometry');
    expect(geometryError?.constraints?.arrayMaxSize).toBeDefined();
  });
});
