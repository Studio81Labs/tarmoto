import { ConfigService } from '@nestjs/config';
import { GraphHopperProvider } from './graphhopper.provider.js';

function makeProvider(
  env: Record<string, string | undefined> = {
    TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
  },
): GraphHopperProvider {
  const config = {
    get: (k: string) => env[k],
  } as unknown as ConfigService;
  return new GraphHopperProvider(config);
}

/** A GraphHopper path with a GeoJSON LineString (points_encoded: false). */
function path(
  coords: Array<[number, number]>,
  distance = 1000,
  time = 60000,
): unknown {
  return { distance, time, points: { coordinates: coords } };
}

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface GhRequestBody {
  points: Array<[number, number]>;
  profile: string;
  points_encoded: boolean;
  'ch.disable'?: boolean;
  custom_model?: {
    priority?: Array<{ if: string; multiply_by: number }>;
    areas?: { type: string; features: Array<{ id: string }> };
  };
  algorithm?: string;
  'alternative_route.max_paths'?: number;
}

function bodyOf(fetchMock: jest.SpyInstance, call = 0): GhRequestBody {
  const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
  return JSON.parse(calls[call]![1].body as string) as GhRequestBody;
}

describe('GraphHopperProvider.route', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
  });
  afterEach(() => fetchMock.mockRestore());

  it('sends [lng,lat] points + GeoJSON request and maps a path to a result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path(
            [
              [14.42, 50.08],
              [14.5, 50.1],
            ],
            12500,
            1_080_000,
          ),
        ],
      }),
    );
    const result = await makeProvider().route([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://gh.test/route');
    expect(opts.method).toBe('POST');
    const body = bodyOf(fetchMock);
    expect(body.points).toEqual([
      [14.42, 50.08],
      [14.5, 50.1],
    ]);
    expect(body.profile).toBe('car');
    expect(body.points_encoded).toBe(false);
    expect(result).toEqual({
      distance_km: 12.5,
      duration_min: 18,
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
    });
  });

  it('avoidHighways → custom_model priority on road_class == MOTORWAY (flexible mode)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidHighways: true },
    );
    const body = bodyOf(fetchMock);
    expect(body['ch.disable']).toBe(true);
    expect(body.custom_model?.priority).toEqual([
      { if: 'road_class == MOTORWAY', multiply_by: 0 },
    ]);
  });

  it('avoidTolls → matches actual toll values when toll is enabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
      TARMOTO_GRAPHHOPPER_TOLL_ENABLED: 'true',
    }).route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidTolls: true },
    );
    expect(bodyOf(fetchMock).custom_model?.priority).toEqual([
      { if: 'toll == ALL || toll == HGV', multiply_by: 0 },
    ]);
  });

  it('enables the toll rule by default on the hosted API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({ TARMOTO_GRAPHHOPPER_API_KEY: 'k' }).route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidTolls: true },
    );
    expect(bodyOf(fetchMock).custom_model?.priority).toContainEqual({
      if: 'toll == ALL || toll == HGV',
      multiply_by: 0,
    });
  });

  it('enables the toll rule for an EXPLICIT hosted base URL + key', async () => {
    // Detected from the resolved host (graphhopper.com), not "no explicit
    // base" — these requests still hit the hosted API, which has `toll`.
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'https://graphhopper.com/api/1',
      TARMOTO_GRAPHHOPPER_API_KEY: 'k',
    }).route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidTolls: true },
    );
    expect(bodyOf(fetchMock).custom_model?.priority).toContainEqual({
      if: 'toll == ALL || toll == HGV',
      multiply_by: 0,
    });
  });

  it('no-ops avoidTolls on a self-hosted graph without the toll encoded value', async () => {
    // Default self-hosted (no API key, no flag): referencing `toll` would
    // make GraphHopper reject the request, so the flag is dropped and a
    // plain route is produced (RoutingProvider no-op contract).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path([
            [0, 0],
            [1, 1],
          ]),
        ],
      }),
    );
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidTolls: true },
    );
    const body = bodyOf(fetchMock);
    expect(body.custom_model).toBeUndefined();
    expect(body['ch.disable']).toBeUndefined();
  });

  it('no-ops avoidTolls when an explicit self-hosted base wins over a leftover key', async () => {
    // The request goes to the self-hosted graph (explicit base wins), so the
    // toll default must follow the endpoint, not the stray key.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path([
            [0, 0],
            [1, 1],
          ]),
        ],
      }),
    );
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
      TARMOTO_GRAPHHOPPER_API_KEY: 'leftover',
    }).route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidTolls: true },
    );
    expect(bodyOf(fetchMock).custom_model).toBeUndefined();
  });

  it('preferQuality → de-weights poor smoothness when quality is enabled (#779)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
      TARMOTO_GRAPHHOPPER_QUALITY_ENABLED: 'true',
    }).route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { preferQuality: true },
    );
    expect(bodyOf(fetchMock).custom_model?.priority).toContainEqual({
      if: 'smoothness == BAD || smoothness == VERY_BAD || smoothness == HORRIBLE || smoothness == VERY_HORRIBLE || smoothness == IMPASSABLE',
      multiply_by: 0.3,
    });
  });

  it('no-ops preferQuality when quality is not enabled (default)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path([
            [0, 0],
            [1, 1],
          ]),
        ],
      }),
    );
    await makeProvider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { preferQuality: true },
    );
    expect(bodyOf(fetchMock).custom_model).toBeUndefined();
  });

  it('excludePolygons → custom_model areas + a priority rule per polygon (#744)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
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
    const body = bodyOf(fetchMock);
    expect(body.custom_model?.priority).toContainEqual({
      if: 'in_closure_0',
      multiply_by: 0,
    });
    expect(body.custom_model?.areas?.type).toBe('FeatureCollection');
    expect(body.custom_model?.areas?.features[0]!.id).toBe('closure_0');
  });

  it('omits custom_model / ch.disable for a plain route', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path([
            [0, 0],
            [1, 1],
          ]),
        ],
      }),
    );
    await makeProvider().route([
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ]);
    const body = bodyOf(fetchMock);
    expect(body.custom_model).toBeUndefined();
    expect(body['ch.disable']).toBeUndefined();
  });

  it('returns null on <2 waypoints without calling fetch', async () => {
    const result = await makeProvider().route([{ lat: 0, lng: 0 }]);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on an upstream error, network failure, or invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad' }, false));
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ]),
    ).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ]),
    ).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(
      await makeProvider().route([
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ]),
    ).toBeNull();
  });

  it('rejects a degenerate (single-point) path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ paths: [path([[14.42, 50.08]])] }),
    );
    expect(
      await makeProvider().route([
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ]),
    ).toBeNull();
  });

  it('appends the API key as a query param when configured (hosted API)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'https://graphhopper.com/api/1',
      TARMOTO_GRAPHHOPPER_API_KEY: 'secret key',
    }).route([
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://graphhopper.com/api/1/route?key=secret%20key');
  });

  it('defaults to the hosted base URL when only the API key is set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({ TARMOTO_GRAPHHOPPER_API_KEY: 'k' }).route([
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://graphhopper.com/api/1/route?key=k');
  });

  it('treats a blank base URL (templated env) as unset, not a relative URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    await makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: '',
      TARMOTO_GRAPHHOPPER_API_KEY: 'k',
    }).route([
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://graphhopper.com/api/1/route?key=k');
  });

  it('caches an identical route briefly so Save can reuse its preview', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        paths: [
          path([
            [14, 50],
            [15, 51],
          ]),
        ],
      }),
    );
    const provider = makeProvider();
    const points = [
      { lat: 50, lng: 14 },
      { lat: 51, lng: 15 },
    ];
    await provider.route(points, { preferQuality: true });
    await provider.route(points, { preferQuality: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical requests into one upstream call', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const provider = makeProvider();
    const points = [
      { lat: 50, lng: 14 },
      { lat: 51, lng: 15 },
    ];
    const first = provider.route(points);
    const second = provider.route(points);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(
      jsonResponse({
        paths: [
          path([
            [14, 50],
            [15, 51],
          ]),
        ],
      }),
    );
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('bounds distinct upstream calls and releases the queue in FIFO order', async () => {
    const releases: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => releases.push(resolve)),
    );
    const provider = makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
      TARMOTO_GRAPHHOPPER_MAX_CONCURRENCY: '2',
    });
    const calls = [0, 1, 2].map((n) =>
      provider.route([
        { lat: 50, lng: 14 + n },
        { lat: 51, lng: 15 + n },
      ]),
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releases.shift()!(jsonResponse({ paths: [] }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const release of releases) release(jsonResponse({ paths: [] }));
    await expect(Promise.all(calls)).resolves.toEqual([null, null, null]);
  });

  it('aborts the upstream call when its final waiter disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init.signal as AbortSignal;
          upstreamSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const result = makeProvider().route(
      [
        { lat: 50, lng: 14 },
        { lat: 51, lng: 15 },
      ],
      undefined,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('starts a fresh identical request while an aborted flight is settling', async () => {
    let resolveAbortedFetch!: (response: Response) => void;
    fetchMock
      // Deliberately leave the first fetch pending after abort to exercise the
      // short window before its promise reaches `finally` and leaves inFlight.
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveAbortedFetch = resolve;
          }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          paths: [
            path([
              [14, 50],
              [15, 51],
            ]),
          ],
        }),
      );
    const provider = makeProvider();
    const points = [
      { lat: 50, lng: 14 },
      { lat: 51, lng: 15 },
    ];
    const controller = new AbortController();
    const aborted = provider.route(points, undefined, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(aborted).resolves.toBeNull();

    const replacement = provider.route(points);
    await expect(replacement).resolves.toMatchObject({ distance_km: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveAbortedFetch(jsonResponse({ paths: [] }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('aborts an upstream call at the configured deadline', async () => {
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init.signal as AbortSignal;
          upstreamSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out', 'TimeoutError')),
            { once: true },
          );
        }),
    );

    const result = makeProvider({
      TARMOTO_GRAPHHOPPER_BASE_URL: 'http://gh.test',
      TARMOTO_GRAPHHOPPER_TIMEOUT_MS: '1',
    }).route([
      { lat: 50, lng: 14 },
      { lat: 51, lng: 15 },
    ]);

    await expect(result).resolves.toBeNull();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

describe('GraphHopperProvider.getAlternatives', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
  });
  afterEach(() => fetchMock.mockRestore());

  const threePaths = {
    paths: [
      path(
        [
          [0, 0],
          [1, 1],
        ],
        1000,
        60000,
      ),
      path(
        [
          [0, 0],
          [1, 2],
        ],
        1100,
        66000,
      ),
      path(
        [
          [0, 0],
          [2, 2],
        ],
        1200,
        72000,
      ),
    ],
  };

  it('requests alternative_route under CH (no ch.disable for filter-less alternatives)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(threePaths));
    const alts = await makeProvider().getAlternatives(0, 0, 1, 1, 3, {
      includePrimary: true,
    });
    const body = bodyOf(fetchMock);
    expect(body.algorithm).toBe('alternative_route');
    expect(body['alternative_route.max_paths']).toBe(3);
    // No custom model → keep Contraction Hierarchies (ch.disable rejected
    // on CH-only server profiles).
    expect(body['ch.disable']).toBeUndefined();
    expect(alts).toHaveLength(3);
    expect(alts[0]!.distance_km).toBe(1); // primary kept at index 0
  });

  it('sets ch.disable when alternatives are combined with a custom model', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(threePaths));
    await makeProvider().getAlternatives(0, 0, 1, 1, 3, {
      includePrimary: true,
      avoidHighways: true,
    });
    const body = bodyOf(fetchMock);
    expect(body.algorithm).toBe('alternative_route');
    expect(body['ch.disable']).toBe(true);
    expect(body.custom_model?.priority).toContainEqual({
      if: 'road_class == MOTORWAY',
      multiply_by: 0,
    });
  });

  it('drops the primary when includePrimary is not set (asks for one extra)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(threePaths));
    const alts = await makeProvider().getAlternatives(0, 0, 1, 1, 2);
    expect(bodyOf(fetchMock)['alternative_route.max_paths']).toBe(3);
    expect(alts).toHaveLength(2);
    // First returned alt is the SECOND path (primary dropped).
    expect(alts[0]!.distance_km).toBe(1.1);
  });

  it('returns [] when GraphHopper yields no paths', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ paths: [] }));
    expect(await makeProvider().getAlternatives(0, 0, 1, 1, 3)).toEqual([]);
  });
});
