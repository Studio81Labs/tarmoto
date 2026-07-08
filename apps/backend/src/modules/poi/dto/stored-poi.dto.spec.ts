import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CorridorBodyDto,
  MAX_CORRIDOR_KINDS,
  MAX_POI_CORRIDOR_POINTS,
} from './stored-poi.dto.js';

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

  // The STOPS tab's widest corridor is 20 km, matching the passes / fun-zones
  // reach; buffer_km must accept it (#919) and reject beyond the cap.
  it('accepts the 20 km STOPS corridor and rejects a wider buffer', async () => {
    const ok = plainToInstance(CorridorBodyDto, {
      route: [point, point],
      buffer_km: 20,
    });
    expect(await validate(ok)).toHaveLength(0);

    const tooWide = plainToInstance(CorridorBodyDto, {
      route: [point, point],
      buffer_km: 21,
    });
    const err = (await validate(tooWide)).find(
      (e) => e.property === 'buffer_km',
    );
    expect(err?.constraints?.max).toBeDefined();
  });

  // `kinds` is a free-form superset and the store read fans out one query per
  // kind, so the list is capped to bound that fan-out on the public endpoint.
  it('rejects a kinds list over the fan-out cap (#919)', async () => {
    const dto = plainToInstance(CorridorBodyDto, {
      route: [point, point],
      kinds: Array.from(
        { length: MAX_CORRIDOR_KINDS + 1 },
        (_, i) => `kind_${i}`,
      ),
    });
    const err = (await validate(dto)).find((e) => e.property === 'kinds');
    expect(err?.constraints?.arrayMaxSize).toBeDefined();
  });
});
