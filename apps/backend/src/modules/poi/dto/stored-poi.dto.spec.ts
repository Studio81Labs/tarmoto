import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CorridorBodyDto, MAX_POI_CORRIDOR_POINTS } from './stored-poi.dto.js';

describe('CorridorBodyDto route validation', () => {
  const point = { lat: 49.1, lng: 16.7 };

  it('accepts a minimal 2-point route', async () => {
    const dto = plainToInstance(CorridorBodyDto, { route: [point, point] });
    expect(await validate(dto)).toHaveLength(0);
  });

  // The endpoint is public, so the vertex cap — not the body limit — is the
  // real bound on how big a spatial query an anonymous client can trigger.
  it('rejects a route over the vertex cap (400) before any query is built', async () => {
    const dto = plainToInstance(CorridorBodyDto, {
      route: Array.from({ length: MAX_POI_CORRIDOR_POINTS + 1 }, () => point),
    });
    const errors = await validate(dto);
    const routeError = errors.find((e) => e.property === 'route');
    expect(routeError?.constraints?.arrayMaxSize).toBeDefined();
  });
});
