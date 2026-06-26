import { ConfigService } from '@nestjs/config';
import { ValhallaProvider } from './valhalla.provider.js';

function provider(): ValhallaProvider {
  const config = {
    get: (k: string) =>
      k === 'TARMOTO_VALHALLA_BASE_URL' ? 'http://valhalla.test' : undefined,
  } as unknown as ConfigService;
  return new ValhallaProvider(config);
}

// Encode helper so the test owns its polyline-6 fixture.
function encodePolyline6(points: Array<[number, number]>): string {
  let lastLat = 0,
    lastLng = 0,
    out = '';
  const enc = (v: number) => {
    let sgn = v << 1;
    if (v < 0) sgn = ~sgn;
    let s = '';
    while (sgn >= 0x20) {
      s += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
      sgn >>>= 5;
    }
    s += String.fromCharCode(sgn + 63);
    return s;
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e6),
      ln = Math.round(lng * 1e6);
    out += enc(la - lastLat) + enc(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

describe('ValhallaProvider.route', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs locations (lon) + decodes the leg shape', async () => {
    const shape = encodePolyline6([
      [50.08, 14.42],
      [50.1, 14.5],
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [{ shape, summary: { length: 88.9, time: 7440 } }],
          summary: { length: 88.9, time: 7440 },
        },
      }),
    });

    const result = await provider().route([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://valhalla.test/route');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.locations).toEqual([
      { lat: 50.08, lon: 14.42 },
      { lat: 50.1, lon: 14.5 },
    ]);
    expect(body.costing).toBe('auto');
    expect(result!.distance_km).toBe(88.9);
    expect(result!.duration_min).toBe(124);
    expect(result!.geometry[0].lat).toBeCloseTo(50.08, 5);
    expect(result!.geometry.at(-1)!.lng).toBeCloseTo(14.5, 5);
  });

  it('sets use_highways=0 when avoidHighways is set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [
            {
              shape: encodePolyline6([
                [0, 0],
                [1, 1],
              ]),
              summary: { length: 1, time: 60 },
            },
          ],
          summary: { length: 1, time: 60 },
        },
      }),
    });
    await provider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidHighways: true },
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.costing_options.auto.use_highways).toBe(0);
  });

  it('returns null when Valhalla cannot route', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'No path' }),
    });
    expect(
      await provider().route([
        { lat: 0, lng: 0 },
        { lat: 9, lng: 9 },
      ]),
    ).toBeNull();
  });
});

describe('ValhallaProvider.getAlternatives', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns primary + alternates when includePrimary', async () => {
    const shape = encodePolyline6([
      [0, 0],
      [1, 1],
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [{ shape, summary: { length: 10, time: 600 } }],
          summary: { length: 10, time: 600 },
        },
        alternates: [
          {
            trip: {
              legs: [{ shape, summary: { length: 12, time: 700 } }],
              summary: { length: 12, time: 700 },
            },
          },
        ],
      }),
    });
    const alts = await provider().getAlternatives(0, 0, 1, 1, 3, {
      includePrimary: true,
    });
    expect(alts.map((a) => a.distance_km)).toEqual([10, 12]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.alternates).toBe(2); // maxAlternatives - 1 extras
  });
});
