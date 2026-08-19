import { ConfigService } from '@nestjs/config';
import { ValhallaProvider } from './valhalla.provider.js';

function makeProvider(): ValhallaProvider {
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

/** Typed shape of the JSON body ValhallaProvider sends to /route. */
interface ValhallaRequestBody {
  locations: Array<{ lat: number; lon: number }>;
  costing: string;
  costing_options?: { auto?: { use_highways?: number; use_tolls?: number } };
  alternates?: number;
  exclude_polygons?: Array<Array<[number, number]>>;
}

/** Build a mock fetch Response returning JSON. */
function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ValhallaProvider.route', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('POSTs locations (lon) + decodes the leg shape', async () => {
    const shape = encodePolyline6([
      [50.08, 14.42],
      [50.1, 14.5],
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          legs: [{ shape, summary: { length: 88.9, time: 7440 } }],
          summary: { length: 88.9, time: 7440 },
        },
      }),
    );

    const result = await makeProvider().route([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const call = calls[0];
    if (!call) throw new Error('expected fetch to have been called');
    const [url, opts] = call;
    expect(url).toBe('http://valhalla.test/route');
    const body = JSON.parse(opts.body as string) as ValhallaRequestBody;
    expect(body.locations).toEqual([
      { lat: 50.08, lon: 14.42 },
      { lat: 50.1, lon: 14.5 },
    ]);
    expect(body.costing).toBe('auto');
    expect(result!.distance_km).toBe(88.9);
    expect(result!.duration_min).toBe(124);
    expect(result!.geometry[0]!.lat).toBeCloseTo(50.08, 5);
    expect(result!.geometry.at(-1)!.lng).toBeCloseTo(14.5, 5);
  });

  it('forwards the caller abort signal to the route request', async () => {
    const controller = new AbortController();

    await makeProvider().route(
      [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      undefined,
      controller.signal,
    );

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]![1].signal).toBe(controller.signal);
  });

  it('sets use_highways=0 when avoidHighways is set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
    );
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidHighways: true },
    );
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    expect(body.costing_options?.auto?.use_highways).toBe(0);
  });

  it('maps the road preference onto use_highways weighting (revision 3)', async () => {
    const trip = {
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
    };
    const cases: Array<[string, number | undefined]> = [
      ['maximum_twisty', 0.05],
      ['scenic_balance', 0.2],
      ['balanced', 0.5],
      ['direct', undefined],
      ['efficient_loop', undefined],
    ];
    for (const [preference, expected] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse(trip));
      await makeProvider().route(
        [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        { preference },
      );
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      const body = JSON.parse(
        calls.at(-1)![1].body as string,
      ) as ValhallaRequestBody;
      expect(body.costing_options?.auto?.use_highways).toBe(expected);
    }
  });

  it('lets a hard avoidHighways win over a soft preference', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
    );
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { preference: 'balanced', avoidHighways: true },
    );
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    expect(body.costing_options?.auto?.use_highways).toBe(0);
  });

  it('passes excludePolygons through as exclude_polygons (#744)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
    );
    const ring: Array<[number, number]> = [
      [16.6, 49.2],
      [16.7, 49.2],
      [16.7, 49.25],
      [16.6, 49.2],
    ];
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { excludePolygons: [ring] },
    );
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    expect(body.exclude_polygons).toEqual([ring]);
  });

  it('omits exclude_polygons when no closures are passed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
    );
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { excludePolygons: [] },
    );
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    expect(body.exclude_polygons).toBeUndefined();
  });

  it('returns null when Valhalla cannot route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'No path' }, false));
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 9, lng: 9 },
      ]),
    ).toBeNull();
  });

  it('returns null when Valhalla is unreachable (fetch rejects)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 9, lng: 9 },
      ]),
    ).toBeNull();
  });

  it('returns null when Valhalla returns a 200 with invalid JSON (does not throw 500)', async () => {
    // Simulate a truncated/malformed response body: fetch resolves ok but
    // json() rejects. Must resolve to null, not propagate the parse error.
    const badResponse = new Response('not-json{{{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    fetchMock.mockResolvedValueOnce(badResponse);
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 9, lng: 9 },
      ]),
    ).toBeNull();
  });

  it('returns null for a degenerate Valhalla shape (<2 decoded points)', async () => {
    // A 200 whose leg decodes to a single point would form invalid LineString
    // geometry; the provider must reject it (-> null -> no-route) so a later
    // save never builds bad route_geom.
    const shape = encodePolyline6([[50.08, 14.42]]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          legs: [{ shape, summary: { length: 0, time: 0 } }],
          summary: { length: 0, time: 0 },
        },
      }),
    );
    expect(
      await makeProvider().route([
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ]),
    ).toBeNull();
  });

  it('returns null when a Valhalla leg is missing its shape (does not throw)', async () => {
    // Malformed 200: a leg with no string `shape`. decodePolyline6 would read
    // `undefined.length` and throw a 500 — the provider must reject the trip.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          legs: [{ summary: { length: 10, time: 600 } }],
          summary: { length: 10, time: 600 },
        },
      }),
    );
    expect(
      await makeProvider().route([
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ]),
    ).toBeNull();
  });

  it('concatenates multi-leg geometry and drops the shared join vertex', async () => {
    // Leg 1: A -> B. Leg 2: B -> C.
    // B appears as the last point of leg 1 AND the first point of leg 2.
    // The provider must drop that duplicate so B appears only once in the result.
    const leg1Shape = encodePolyline6([
      [10.0, 20.0],
      [10.5, 20.5], // B — shared join vertex
    ]);
    const leg2Shape = encodePolyline6([
      [10.5, 20.5], // same B — must be dropped
      [11.0, 21.0],
    ]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          legs: [
            { shape: leg1Shape, summary: { length: 80, time: 3600 } },
            { shape: leg2Shape, summary: { length: 90, time: 4000 } },
          ],
          summary: { length: 170, time: 7600 },
        },
      }),
    );

    const result = await makeProvider().route([
      { lat: 10.0, lng: 20.0 },
      { lat: 10.5, lng: 20.5 },
      { lat: 11.0, lng: 21.0 },
    ]);

    expect(result).not.toBeNull();
    // 2 points in leg1 + 2 points in leg2 - 1 shared vertex = 3 total.
    expect(result!.geometry).toHaveLength(3);
    expect(result!.geometry[0]!.lat).toBeCloseTo(10.0, 5);
    expect(result!.geometry[0]!.lng).toBeCloseTo(20.0, 5);
    expect(result!.geometry[1]!.lat).toBeCloseTo(10.5, 5);
    expect(result!.geometry[1]!.lng).toBeCloseTo(20.5, 5);
    expect(result!.geometry[2]!.lat).toBeCloseTo(11.0, 5);
    expect(result!.geometry[2]!.lng).toBeCloseTo(21.0, 5);
    expect(result!.distance_km).toBe(170);
  });
});

describe('ValhallaProvider.getAlternatives', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('returns primary + alternates when includePrimary', async () => {
    const shape = encodePolyline6([
      [0, 0],
      [1, 1],
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
    );
    const alts = await makeProvider().getAlternatives(0, 0, 1, 1, 3, {
      includePrimary: true,
    });
    expect(alts.map((a) => a.distance_km)).toEqual([10, 12]);
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    expect(body.alternates).toBe(2); // maxAlternatives - 1 extras
  });

  it('forwards the caller abort signal to the alternatives request', async () => {
    const controller = new AbortController();

    await makeProvider().getAlternatives(
      0,
      0,
      1,
      1,
      3,
      undefined,
      controller.signal,
    );

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]![1].signal).toBe(controller.signal);
  });

  it('returns only alternates (not primary) when includePrimary=false', async () => {
    const primaryShape = encodePolyline6([
      [0, 0],
      [0.5, 0.5],
    ]);
    const alt1Shape = encodePolyline6([
      [0, 0],
      [1, 0],
    ]);
    const alt2Shape = encodePolyline6([
      [0, 0],
      [0, 1],
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          legs: [{ shape: primaryShape, summary: { length: 5, time: 300 } }],
          summary: { length: 5, time: 300 },
        },
        alternates: [
          {
            trip: {
              legs: [{ shape: alt1Shape, summary: { length: 20, time: 900 } }],
              summary: { length: 20, time: 900 },
            },
          },
          {
            trip: {
              legs: [{ shape: alt2Shape, summary: { length: 30, time: 1200 } }],
              summary: { length: 30, time: 1200 },
            },
          },
        ],
      }),
    );
    const alts = await makeProvider().getAlternatives(0, 0, 1, 1, 2, {
      includePrimary: false,
    });
    // Primary (distance=5) must NOT appear; only the two alternates.
    expect(alts.map((a) => a.distance_km)).toEqual([20, 30]);
    // Result is bounded by maxAlternatives.
    expect(alts).toHaveLength(2);
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as ValhallaRequestBody;
    // alternates in the request equals maxAlternatives (no subtraction).
    expect(body.alternates).toBe(2);
  });

  it('returns [] when Valhalla is unreachable (fetch rejects)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const alts = await makeProvider().getAlternatives(0, 0, 1, 1, 3);
    expect(alts).toEqual([]);
  });
});
