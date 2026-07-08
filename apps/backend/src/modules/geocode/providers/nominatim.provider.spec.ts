import { ConfigService } from '@nestjs/config';
import {
  NominatimProvider,
  isDefaultPublicNominatim,
} from './nominatim.provider.js';

// ConfigService stub — always returns the default, so the provider uses the
// public endpoint and the built-in User-Agent.
const config = {
  get: (_key: string, fallback: string) => fallback,
} as unknown as ConfigService;

describe('NominatimProvider', () => {
  // Stub `fetch` so we assert on the request URL and feed canned payloads
  // without a real HTTP round-trip.
  let originalFetch: typeof fetch;
  let capturedUrl: string;
  let nextPayload: unknown;
  let nextOk: boolean;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = '';
    nextPayload = {};
    nextOk = true;
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: nextOk,
        status: nextOk ? 200 : 502,
        statusText: nextOk ? 'OK' : 'Bad Gateway',
        json: () => Promise.resolve(nextPayload),
      } as unknown as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('search', () => {
    it('requests /search with the query + limit and normalizes rows', async () => {
      nextPayload = [
        {
          display_name: 'Brno, Czechia',
          lat: '49.2',
          lon: '16.6',
          importance: 0.7,
        },
        { display_name: '', lat: '1', lon: '1' }, // no label → dropped
      ];
      const provider = new NominatimProvider(config);
      const results = await provider.search('Brno', 5);

      expect(capturedUrl).toContain('/search?');
      expect(capturedUrl).toContain('q=Brno');
      expect(capturedUrl).toContain('limit=5');
      expect(results).toEqual([
        { label: 'Brno, Czechia', lat: 49.2, lng: 16.6, importance: 0.7 },
      ]);
    });
  });

  describe('reverse', () => {
    it('requests /reverse with the coordinate, zoom, and address detail', async () => {
      nextPayload = { address: { city: 'Brno' } };
      const provider = new NominatimProvider(config);
      await provider.reverse(49.2, 16.6);

      expect(capturedUrl).toContain('/reverse?');
      expect(capturedUrl).toContain('lat=49.2');
      expect(capturedUrl).toContain('lon=16.6');
      expect(capturedUrl).toContain('zoom=14');
      expect(capturedUrl).toContain('addressdetails=1');
    });

    it('names a point by its settlement, preferring city/town/village over admin areas', async () => {
      nextPayload = {
        address: {
          village: 'Telč',
          county: 'Jihlava',
          state: 'Vysočina',
          country: 'Czechia',
        },
      };
      const provider = new NominatimProvider(config);
      expect(await provider.reverse(49.18, 15.45)).toEqual({ label: 'Telč' });
    });

    it('falls back through administrative areas when no settlement is present', async () => {
      nextPayload = { address: { state: 'Tyrol', country: 'Austria' } };
      const provider = new NominatimProvider(config);
      expect(await provider.reverse(47, 11)).toEqual({ label: 'Tyrol' });
    });

    // Split into two single-call tests: a second call on the same provider
    // would wait one real second on the upstream min-spacing limiter.
    it('falls back to the matched feature name when the address has no settlement', async () => {
      nextPayload = { name: 'Grossglockner High Alpine Road', address: {} };
      const provider = new NominatimProvider(config);
      expect(await provider.reverse(47.07, 12.83)).toEqual({
        label: 'Grossglockner High Alpine Road',
      });
    });

    it('falls back to the display-name head when there is no feature name', async () => {
      nextPayload = { display_name: 'Some Pass, A Region, A Country' };
      const provider = new NominatimProvider(config);
      expect(await provider.reverse(46, 13)).toEqual({ label: 'Some Pass' });
    });

    it('returns null when the provider cannot name the point', async () => {
      nextPayload = { error: 'Unable to geocode' };
      const provider = new NominatimProvider(config);
      expect(await provider.reverse(0, 0)).toBeNull();
    });

    it('throws on a non-OK upstream response', async () => {
      nextOk = false;
      const provider = new NominatimProvider(config);
      await expect(provider.reverse(49, 16)).rejects.toThrow(
        'Nominatim API error',
      );
    });
  });
});

describe('isDefaultPublicNominatim', () => {
  it('is true for the public OSMF instance (with or without trailing slash)', () => {
    expect(
      isDefaultPublicNominatim('https://nominatim.openstreetmap.org'),
    ).toBe(true);
    expect(
      isDefaultPublicNominatim('https://nominatim.openstreetmap.org/'),
    ).toBe(true);
  });

  it('is false for a self-hosted endpoint (spacing disabled there)', () => {
    expect(
      isDefaultPublicNominatim('https://nominatim.internal.example.com/'),
    ).toBe(false);
    expect(isDefaultPublicNominatim('http://localhost:8080/')).toBe(false);
  });
});
