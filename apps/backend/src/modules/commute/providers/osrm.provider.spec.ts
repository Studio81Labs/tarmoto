import { ConfigService } from '@nestjs/config';
import { OsrmProvider } from './osrm.provider.js';

describe('OsrmProvider', () => {
  const baseUrl = 'http://osrm.test';
  let provider: OsrmProvider;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue(baseUrl),
    } as unknown as ConfigService;
    provider = new OsrmProvider(config);

    // Build a fresh Response per call — `Response` bodies are
    // single-shot streams, so a single shared instance would throw on
    // the second test that reuses the default mock.
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'Ok', routes: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('encodes exclude with a literal comma, not %2C, so OSRM honours it', async () => {
    await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3, {
      avoidHighways: true,
      avoidTolls: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as Array<[string]>;
    const requestedUrl = calls[0][0];
    // Regression: URLSearchParams would write `motorway%2Ctoll`,
    // which OSRM's custom HTTP handler does not reliably decode.
    expect(requestedUrl).toContain('exclude=motorway,toll');
    expect(requestedUrl).not.toContain('%2C');
  });

  it('omits the exclude parameter entirely when no avoidance is requested', async () => {
    await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3);

    const calls = fetchMock.mock.calls as Array<[string]>;
    const requestedUrl = calls[0][0];
    expect(requestedUrl).not.toContain('exclude=');
    // Sanity: the always-on params are still present.
    expect(requestedUrl).toContain('alternatives=3');
    expect(requestedUrl).toContain('overview=full');
    expect(requestedUrl).toContain('geometries=geojson');
  });

  it('emits exclude=motorway when only highways are avoided', async () => {
    await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3, {
      avoidHighways: true,
    });

    const calls = fetchMock.mock.calls as Array<[string]>;
    const requestedUrl = calls[0][0];
    expect(requestedUrl).toContain('exclude=motorway');
    expect(requestedUrl).not.toContain('toll');
  });

  it('drops the primary route by default (commute alternatives semantic)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'Ok',
          routes: [
            {
              distance: 1000,
              duration: 600,
              geometry: { coordinates: [[1, 2]] },
            },
            {
              distance: 1100,
              duration: 700,
              geometry: { coordinates: [[3, 4]] },
            },
            {
              distance: 1200,
              duration: 800,
              geometry: { coordinates: [[5, 6]] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const out = await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3);
    // Only the two real alternatives — primary at index 0 is skipped.
    expect(out).toHaveLength(2);
    expect(out[0].distance_km).toBe(1.1);
    expect(out[1].distance_km).toBe(1.2);
  });

  it('asks OSRM for one fewer alternative when includePrimary is set (preserves count budget)', async () => {
    // Regression: when `includePrimary=true` we want `maxAlternatives`
    // candidates *including* the primary. OSRM's `alternatives=N`
    // computes N alts in addition to the primary, so we have to ask
    // for N-1 to get back N total — otherwise the slice silently
    // drops the last alternative OSRM computed.
    await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3, {
      includePrimary: true,
    });
    const calls = fetchMock.mock.calls as Array<[string]>;
    expect(calls[0][0]).toContain('alternatives=2');

    // Sanity: without includePrimary, the parameter is unchanged.
    fetchMock.mockClear();
    await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3);
    expect((fetchMock.mock.calls as Array<[string]>)[0][0]).toContain(
      'alternatives=3',
    );
  });

  it('keeps the primary route when includePrimary is set (trip-generator semantic)', async () => {
    // Regression: earlier the trip generator dropped OSRM's primary
    // and any leg with a single returned route fell through to a
    // synthetic 0 km stub day.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'Ok',
          routes: [
            {
              distance: 1000,
              duration: 600,
              geometry: { coordinates: [[1, 2]] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const out = await provider.getAlternatives(47.0, 11.5, 47.2, 11.7, 3, {
      includePrimary: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].distance_km).toBe(1);
  });

  it('exposes a stable version identifier so cached commute geometry can be invalidated on a swap (#361)', () => {
    // The string itself is opaque; what matters is that callers see a
    // non-empty value that changes when the engine semantics change.
    // Bump this assertion in lockstep with the provider when the
    // contract is broken.
    expect(provider.version).toBe('osrm-v1');
  });
});
