import { ConfigService } from '@nestjs/config';
import {
  classifyPoiTags,
  extractPoiHint,
  OverpassPoiProvider,
  parseStarsTag,
} from './overpass.provider.js';

describe('parseStarsTag', () => {
  it('returns null for falsy or non-numeric input', () => {
    expect(parseStarsTag(undefined)).toBeNull();
    expect(parseStarsTag(null)).toBeNull();
    expect(parseStarsTag('')).toBeNull();
    expect(parseStarsTag('star')).toBeNull();
  });

  it('returns plain integer ratings verbatim', () => {
    expect(parseStarsTag('3')).toBe(3);
    expect(parseStarsTag('5')).toBe(5);
  });

  it('floors fractional ratings instead of splitting the decimal', () => {
    expect(parseStarsTag('4.5')).toBe(4);
    expect(parseStarsTag('3.9')).toBe(3);
  });

  it('handles the trailing superior marker', () => {
    expect(parseStarsTag('4S')).toBe(4);
    expect(parseStarsTag('5 S')).toBe(5);
  });

  it('picks the upper endpoint of a range', () => {
    expect(parseStarsTag('3-4')).toBe(4);
    expect(parseStarsTag('4-4.5')).toBe(4);
    expect(parseStarsTag('2-5')).toBe(5);
  });

  it('rejects values outside the 1..5 UI range', () => {
    expect(parseStarsTag('0')).toBeNull();
    expect(parseStarsTag('6')).toBeNull();
    expect(parseStarsTag('6S')).toBeNull();
    expect(parseStarsTag('10')).toBeNull();
  });
});

describe('classifyPoiTags', () => {
  it('classifies amenity=restaurant and amenity=cafe', () => {
    expect(classifyPoiTags({ amenity: 'restaurant' })).toBe('restaurant');
    expect(classifyPoiTags({ amenity: 'cafe' })).toBe('cafe');
  });

  it('classifies tourism=viewpoint', () => {
    expect(classifyPoiTags({ tourism: 'viewpoint' })).toBe('viewpoint');
  });

  it('classifies amenity=fuel as fuel_station', () => {
    // OSM tags fuel stations as `amenity=fuel`; we remap to the
    // rider-facing `fuel_station` kind so the mobile card label isn't
    // ambiguous next to viewpoints and cafés.
    expect(classifyPoiTags({ amenity: 'fuel' })).toBe('fuel_station');
  });

  it('ignores unrelated amenities and tourism values', () => {
    expect(classifyPoiTags({ amenity: 'bar' })).toBeNull();
    expect(classifyPoiTags({ tourism: 'hotel' })).toBeNull();
    expect(classifyPoiTags({})).toBeNull();
  });

  it('returns null when amenity=fuel is not requested', () => {
    // A highway-rest-stop fuel element leaking into a viewpoint-only
    // query must still be dropped — same rationale as the amenity=cafe
    // guard above.
    expect(classifyPoiTags({ amenity: 'fuel' }, ['viewpoint'])).toBeNull();
  });

  it('defaults to amenity over tourism when no requested kinds are given', () => {
    // Real-world data: a mountaintop restaurant that is also tagged
    // `tourism=viewpoint`. With no caller context, the default stays
    // amenity-first so the element keeps its primary category.
    expect(
      classifyPoiTags({ amenity: 'restaurant', tourism: 'viewpoint' }),
    ).toBe('restaurant');
  });

  it('picks the requested kind from a dual-tagged element', () => {
    // The bug Bugbot caught: if the caller asked for viewpoints only,
    // a dual-tagged viewpoint-restaurant must be classified as a
    // viewpoint — otherwise the post-query filter drops it even though
    // the Overpass query only fetched it *because* it is a viewpoint.
    expect(
      classifyPoiTags({ amenity: 'restaurant', tourism: 'viewpoint' }, [
        'viewpoint',
      ]),
    ).toBe('viewpoint');
  });

  it('keeps the amenity-first priority when multiple matches are all requested', () => {
    // Deterministic tie-break so the caller always sees the same row
    // per element even if the request includes both kinds.
    expect(
      classifyPoiTags({ amenity: 'restaurant', tourism: 'viewpoint' }, [
        'restaurant',
        'viewpoint',
      ]),
    ).toBe('restaurant');
  });

  it('returns null when none of the element kinds are in requestedKinds', () => {
    // An amenity=cafe element in a viewpoint-only query shouldn't
    // leak through — the service layer relies on this to stop
    // double-filtering downstream.
    expect(classifyPoiTags({ amenity: 'cafe' }, ['viewpoint'])).toBeNull();
  });
});

describe('extractPoiHint', () => {
  it('returns cuisine for restaurants and cafés', () => {
    expect(extractPoiHint('restaurant', { cuisine: 'italian' })).toBe(
      'italian',
    );
    expect(extractPoiHint('cafe', { cuisine: 'coffee_shop' })).toBe(
      'coffee shop',
    );
  });

  it('returns description then view_type for viewpoints', () => {
    expect(
      extractPoiHint('viewpoint', { description: 'Summit panorama' }),
    ).toBe('Summit panorama');
    expect(extractPoiHint('viewpoint', { view_type: 'panorama' })).toBe(
      'panorama',
    );
  });

  it('returns brand then operator for fuel stations', () => {
    // Brand is the rider-facing sign (`Shell`, `OMV`). Operator is the
    // legal entity running the pumps and is usually the right fallback
    // when brand is missing on small independent stations.
    expect(extractPoiHint('fuel_station', { brand: 'Shell' })).toBe('Shell');
    expect(extractPoiHint('fuel_station', { operator: 'Local Co-op' })).toBe(
      'Local Co-op',
    );
    // Brand wins over operator when both are present so the label
    // matches the pylon signage rather than the holding company.
    expect(
      extractPoiHint('fuel_station', {
        brand: 'OMV',
        operator: 'OMV Česká republika',
      }),
    ).toBe('OMV');
  });

  it('normalizes semi-colon-separated cuisine lists', () => {
    expect(extractPoiHint('restaurant', { cuisine: 'pizza;pasta' })).toBe(
      'pizza pasta',
    );
  });

  it('returns null when no hint tag is present', () => {
    expect(extractPoiHint('restaurant', {})).toBeNull();
    expect(
      extractPoiHint('viewpoint', { name: 'Nameless Viewpoint' }),
    ).toBeNull();
    expect(
      extractPoiHint('fuel_station', { name: 'Unnamed station' }),
    ).toBeNull();
  });
});

describe('OverpassPoiProvider.findPointsOfInterestAroundPoints', () => {
  const config = {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService;

  // Stub `fetch` so we can assert on the emitted Overpass QL without a
  // real HTTP round-trip.
  let originalFetch: typeof fetch;
  let capturedBody: string | null;
  let capturedHeaders: Record<string, string> | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedBody = null;
    capturedHeaders = null;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      capturedHeaders = (init?.headers ?? null) as Record<
        string,
        string
      > | null;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ elements: [] }),
      } as unknown as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('emits a single multi-centre `around:` clause for all sample points', async () => {
    const provider = new OverpassPoiProvider(config);
    const points = [
      { lat: 49.0, lng: 16.75 },
      { lat: 49.5, lng: 16.75 },
      { lat: 50.0, lng: 16.75 },
    ];
    await provider.findPointsOfInterestAroundPoints(points, 2, [
      'fuel_station',
    ]);

    expect(capturedBody).not.toBeNull();
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    // One `around:` clause carrying every lat/lng pair — that's the
    // cost saving over looping one provider call per sample.
    expect(decoded).toContain('around:2000,49,16.75,49.5,16.75,50,16.75');
    // Fuel stations live at `amenity=fuel`; confirm the kind → tag
    // mapping still holds through the multi-point path.
    expect(decoded).toContain('amenity');
    expect(decoded).toContain('fuel');
  });

  it('short-circuits to an empty array on zero points or kinds', async () => {
    const provider = new OverpassPoiProvider(config);
    const none = await provider.findPointsOfInterestAroundPoints([], 2, [
      'fuel_station',
    ]);
    const noKinds = await provider.findPointsOfInterestAroundPoints(
      [{ lat: 49, lng: 16 }],
      2,
      [],
    );
    expect(none).toEqual([]);
    expect(noKinds).toEqual([]);
    // Neither case should have hit `fetch`.
    expect(capturedBody).toBeNull();
  });

  it('sends Accept and User-Agent headers required by Overpass mirrors', async () => {
    // Regression for issue #476: bare requests were rejected with
    // HTTP 406 Not Acceptable because the public Overpass mirror
    // requires both an `Accept` header and an identifying
    // `User-Agent`. Match the Nominatim provider's contract.
    const provider = new OverpassPoiProvider(config);
    await provider.findPointsOfInterestAroundPoints([{ lat: 49, lng: 16 }], 2, [
      'fuel_station',
    ]);

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!['Accept']).toBe('application/json');
    expect(capturedHeaders!['User-Agent']).toBe(
      'Tarmoto/1.0 (https://tarmoto.app)',
    );
    // The form encoding stays — Overpass parses POSTed `data=` payloads
    // as `application/x-www-form-urlencoded`, not JSON.
    expect(capturedHeaders!['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('honors TARMOTO_OVERPASS_UA override for the User-Agent header', async () => {
    // Self-hosted deployments and forks can identify themselves
    // separately so abuse complaints route to the right operator.
    const customConfig = {
      get: (key: string, fallback: string) =>
        key === 'TARMOTO_OVERPASS_UA'
          ? 'CustomFork/2.0 (mailto:ops@example.com)'
          : fallback,
    } as unknown as ConfigService;
    const provider = new OverpassPoiProvider(customConfig);
    await provider.findPointsOfInterestAroundPoints([{ lat: 49, lng: 16 }], 2, [
      'fuel_station',
    ]);

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!['User-Agent']).toBe(
      'CustomFork/2.0 (mailto:ops@example.com)',
    );
  });

  it('surfaces upstream HTTP errors with status and statusText', async () => {
    // Without `Accept`/`User-Agent` headers some Overpass mirrors
    // reply 406; preserve the status surface so operators can spot
    // the regression in logs if it ever returns.
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 406,
        statusText: 'Not Acceptable',
        json: () => Promise.resolve({}),
      } as unknown as Response);

    const provider = new OverpassPoiProvider(config);
    await expect(
      provider.findPointsOfInterestAroundPoints([{ lat: 49, lng: 16 }], 2, [
        'fuel_station',
      ]),
    ).rejects.toThrow('Overpass API error: 406 Not Acceptable');
  });
});

describe('OverpassPoiProvider.findPointsOfInterestInBbox', () => {
  const config = {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService;

  let originalFetch: typeof fetch;
  let capturedBody: string | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedBody = null;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ elements: [] }),
      } as unknown as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('emits a (south,west,north,east) bbox filter for node + way', async () => {
    const provider = new OverpassPoiProvider(config);
    await provider.findPointsOfInterestInBbox(
      { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
      ['restaurant', 'fuel_station'],
    );

    expect(capturedBody).not.toBeNull();
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    // Overpass bbox order is south,west,north,east.
    expect(decoded).toContain('(49.3,18,49.75,18.9)');
    // Both restaurant + fuel are `amenity`, so they share one regex.
    expect(decoded).toContain('node["amenity"~"^(restaurant|fuel)$"]');
    expect(decoded).toContain('way["amenity"~"^(restaurant|fuel)$"]');
  });

  it('short-circuits to an empty array on zero kinds (no fetch)', async () => {
    const provider = new OverpassPoiProvider(config);
    const result = await provider.findPointsOfInterestInBbox(
      { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
      [],
    );
    expect(result).toEqual([]);
    expect(capturedBody).toBeNull();
  });
});
