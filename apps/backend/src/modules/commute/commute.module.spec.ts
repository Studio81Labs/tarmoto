import { ConfigService } from '@nestjs/config';
import { routingProviderFactory } from './commute.module.js';
import type { OsrmProvider } from './providers/osrm.provider.js';
import type { ValhallaProvider } from './providers/valhalla.provider.js';

describe('routingProviderFactory', () => {
  const osrm = { id: 'osrm' } as unknown as OsrmProvider;
  const valhalla = { id: 'valhalla' } as unknown as ValhallaProvider;
  const config = (value: string | undefined): ConfigService =>
    ({ get: () => value }) as unknown as ConfigService;

  it('uses Valhalla when TARMOTO_VALHALLA_BASE_URL is configured', () => {
    expect(
      routingProviderFactory(config('http://localhost:8002'), osrm, valhalla),
    ).toBe(valhalla);
  });

  it('falls back to OSRM when TARMOTO_VALHALLA_BASE_URL is unset/empty', () => {
    // Default `pnpm db:up` setup: Valhalla (opt-in compose profile) isn't
    // running, so commute + trip generation must stay on OSRM.
    expect(routingProviderFactory(config(undefined), osrm, valhalla)).toBe(
      osrm,
    );
    expect(routingProviderFactory(config(''), osrm, valhalla)).toBe(osrm);
  });
});
