import { ConfigService } from '@nestjs/config';
import { MapillaryGraphProvider } from './mapillary-graph.provider.js';

function makeConfig(token?: string): ConfigService {
  return { get: () => token } as unknown as ConfigService;
}

describe('MapillaryGraphProvider', () => {
  let originalFetch: typeof fetch;
  let capturedUrl: string;
  let capturedInit: RequestInit | undefined;
  let nextPayload: unknown;
  let nextOk: boolean;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = '';
    capturedInit = undefined;
    nextPayload = { data: [] };
    nextOk = true;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
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

  it('is inert without a token — returns null and never calls the API', async () => {
    const provider = new MapillaryGraphProvider(makeConfig(undefined));
    await expect(provider.nearestImage(46.5, 10.4)).resolves.toBeNull();
    expect(capturedUrl).toBe('');
  });

  it('queries the radius search with the OAuth header and normalizes the image', async () => {
    nextPayload = {
      data: [
        {
          id: '1',
          captured_at: Date.UTC(2024, 8, 15), // 2024-09-15
          thumb_1024_url: 'https://img/1',
          compass_angle: 90,
          is_pano: false,
          creator: { username: 'rider' },
        },
      ],
    };
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    const image = await provider.nearestImage(46.5, 10.4);

    expect(image).toEqual({
      imageUrl: 'https://img/1',
      capturedAt: '2024-09-15',
      attribution: '© rider · Mapillary (CC BY-SA)',
    });
    expect(capturedUrl).toContain('graph.mapillary.com/images');
    expect(capturedUrl).toContain('radius=50');
    expect(capturedUrl).toContain('lat=46.5');
    expect(capturedUrl).toContain('lng=10.4');
    expect(
      (capturedInit?.headers as Record<string, string>).Authorization,
    ).toBe('OAuth MLY|tok');
  });

  it('prefers the image whose compass angle best matches the travel bearing', async () => {
    nextPayload = {
      data: [
        { id: 'a', thumb_1024_url: 'https://img/a', compass_angle: 10 },
        { id: 'b', thumb_1024_url: 'https://img/b', compass_angle: 175 },
      ],
    };
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    // Bearing 180 → 'b' (175, delta 5) beats 'a' (10, delta 170).
    const image = await provider.nearestImage(46.5, 10.4, 180);
    expect(image?.imageUrl).toBe('https://img/b');
  });

  it('skips 360° panoramas in favour of a flat frame', async () => {
    nextPayload = {
      data: [
        { id: 'pano', thumb_1024_url: 'https://img/pano', is_pano: true },
        { id: 'flat', thumb_1024_url: 'https://img/flat', is_pano: false },
      ],
    };
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    const image = await provider.nearestImage(46.5, 10.4);
    expect(image?.imageUrl).toBe('https://img/flat');
  });

  it('returns null when there is no coverage', async () => {
    nextPayload = { data: [] };
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    await expect(provider.nearestImage(46.5, 10.4)).resolves.toBeNull();
  });

  it('falls back to a bare Mapillary credit when the creator is absent', async () => {
    nextPayload = {
      data: [{ id: '1', thumb_1024_url: 'https://img/1', is_pano: false }],
    };
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    const image = await provider.nearestImage(46.5, 10.4);
    expect(image?.attribution).toBe('Mapillary (CC BY-SA)');
  });

  it('throws on a non-OK upstream response (service turns it into no imagery)', async () => {
    nextOk = false;
    const provider = new MapillaryGraphProvider(makeConfig('MLY|tok'));
    await expect(provider.nearestImage(46.5, 10.4)).rejects.toThrow(
      /Mapillary API error/,
    );
  });
});
