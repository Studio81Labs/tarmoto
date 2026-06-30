import { ConfigService } from '@nestjs/config';
import { routingProviderFactory } from './commute.module.js';
import type { OsrmProvider } from './providers/osrm.provider.js';
import type { ValhallaProvider } from './providers/valhalla.provider.js';
import type { GraphHopperProvider } from './providers/graphhopper.provider.js';

describe('routingProviderFactory', () => {
  const osrm = { id: 'osrm' } as unknown as OsrmProvider;
  const valhalla = { id: 'valhalla' } as unknown as ValhallaProvider;
  const graphhopper = { id: 'graphhopper' } as unknown as GraphHopperProvider;

  // Per-key config so precedence between engine URLs can be exercised.
  const config = (env: Record<string, string | undefined>): ConfigService =>
    ({ get: (k: string) => env[k] }) as unknown as ConfigService;

  it('prefers GraphHopper when TARMOTO_GRAPHHOPPER_BASE_URL is configured', () => {
    expect(
      routingProviderFactory(
        config({
          TARMOTO_GRAPHHOPPER_BASE_URL: 'http://localhost:8989',
          // Even if Valhalla is also set, GraphHopper wins (ADR-0004).
          TARMOTO_VALHALLA_BASE_URL: 'http://localhost:8002',
        }),
        osrm,
        valhalla,
        graphhopper,
      ),
    ).toBe(graphhopper);
  });

  it('selects GraphHopper when only the API key is set (hosted Directions API)', () => {
    expect(
      routingProviderFactory(
        config({ TARMOTO_GRAPHHOPPER_API_KEY: 'k' }),
        osrm,
        valhalla,
        graphhopper,
      ),
    ).toBe(graphhopper);
  });

  it('uses Valhalla when only TARMOTO_VALHALLA_BASE_URL is configured', () => {
    expect(
      routingProviderFactory(
        config({ TARMOTO_VALHALLA_BASE_URL: 'http://localhost:8002' }),
        osrm,
        valhalla,
        graphhopper,
      ),
    ).toBe(valhalla);
  });

  it('falls back to OSRM when no engine URL is set', () => {
    // Default `pnpm db:up` setup: the opt-in routing engines aren't running,
    // so commute + trip generation must stay on OSRM.
    expect(
      routingProviderFactory(config({}), osrm, valhalla, graphhopper),
    ).toBe(osrm);
    expect(
      routingProviderFactory(
        config({
          TARMOTO_GRAPHHOPPER_BASE_URL: '',
          TARMOTO_VALHALLA_BASE_URL: '',
        }),
        osrm,
        valhalla,
        graphhopper,
      ),
    ).toBe(osrm);
  });
});
