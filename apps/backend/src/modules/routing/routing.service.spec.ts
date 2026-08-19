import { BadGatewayException } from '@nestjs/common';
import { RoutingService } from './routing.service.js';

describe('RoutingService.route', () => {
  const provider = {
    route: jest.fn(),
    getAlternatives: jest.fn(),
    version: 'valhalla-v1',
  };
  const enrichment = { aggregate: jest.fn() };
  const service = new RoutingService(provider, enrichment as never);

  beforeEach(() => {
    provider.route.mockReset();
    enrichment.aggregate.mockReset();
  });

  it('routes + enriches and shapes the response', async () => {
    provider.route.mockResolvedValueOnce({
      distance_km: 88.9,
      duration_min: 124,
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
    });
    enrichment.aggregate.mockResolvedValueOnce({
      avgQuality: 4.0,
      curvinessScore: 6.1,
      scenicScore: 3.2,
      elevationGain: 540,
      elevationLoss: 540,
      hazardCount: 0,
      surfaceMixMetres: { asphalt: 82000 },
    });

    const res = await service.route({
      waypoints: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      options: { avoid_highways: true },
    });

    expect(provider.route).toHaveBeenCalledWith(
      [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      { avoidHighways: true, avoidTolls: undefined, preferQuality: undefined },
    );
    expect(res).toEqual({
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      distance_km: 88.9,
      duration_min: 124,
      avg_quality: 4.0,
      curviness_score: 6.1,
      elevation_gain_m: 540,
      surface_mix: { asphalt: 82000 },
    });
  });

  it('maps prefer_quality through to the provider (#779)', async () => {
    provider.route.mockResolvedValueOnce({
      distance_km: 1,
      duration_min: 1,
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
    });
    enrichment.aggregate.mockResolvedValueOnce({
      avgQuality: 0,
      curvinessScore: 0,
      scenicScore: 0,
      elevationGain: 0,
      elevationLoss: 0,
      hazardCount: 0,
      surfaceMixMetres: {},
    });
    await service.route({
      waypoints: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      options: { prefer_quality: true },
    });
    expect(provider.route).toHaveBeenCalledWith(expect.anything(), {
      avoidHighways: undefined,
      avoidTolls: undefined,
      preferQuality: true,
    });
  });

  it('throws 502 when the engine cannot route', async () => {
    provider.route.mockResolvedValueOnce(null);
    await expect(
      service.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 9, lng: 9 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(enrichment.aggregate).not.toHaveBeenCalled();
  });
});
