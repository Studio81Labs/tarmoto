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

    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'Ok', routes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
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
});
