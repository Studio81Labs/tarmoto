import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckRouteDto, MAX_CHECK_ROUTE_POINTS } from './passes.dto.js';

describe('CheckRouteDto route validation', () => {
  const point = { lat: 49.1, lng: 16.7 };

  it('accepts a minimal 2-point route', async () => {
    const dto = plainToInstance(CheckRouteDto, { route: [point, point] });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts validated additional disconnected route polylines', async () => {
    const dto = plainToInstance(CheckRouteDto, {
      route: [point, point],
      additional_routes: [{ points: [point, point] }],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an additional route with fewer than 2 points', async () => {
    const dto = plainToInstance(CheckRouteDto, {
      route: [point, point],
      additional_routes: [{ points: [point] }],
    });
    const errors = await validate(dto);
    expect(
      errors.find((error) => error.property === 'additional_routes'),
    ).toBeDefined();
  });

  it('rejects a route over the vertex cap (400) before any query is built', async () => {
    const dto = plainToInstance(CheckRouteDto, {
      route: Array.from({ length: MAX_CHECK_ROUTE_POINTS + 1 }, () => point),
    });
    const errors = await validate(dto);
    const routeError = errors.find((e) => e.property === 'route');
    expect(routeError?.constraints?.arrayMaxSize).toBeDefined();
  });
});
