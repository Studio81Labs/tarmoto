import { ConfigService } from '@nestjs/config';
import {
  classifyPoiTags,
  extractPoiHint,
  extractStoredPoiFields,
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

describe('extractStoredPoiFields', () => {
  it('captures opening hours, cuisine and address from a fully tagged element', () => {
    const fields = extractStoredPoiFields({
      amenity: 'restaurant',
      name: 'U Fleku',
      opening_hours: 'Mo-Su 11:00-23:00',
      cuisine: 'czech;beer',
      'addr:street': 'Křemencova',
      'addr:housenumber': '11',
      'addr:city': 'Praha',
      'addr:postcode': '110 00',
      'addr:country': 'cz',
    });
    expect(fields.opening_hours).toBe('Mo-Su 11:00-23:00');
    // Cuisine reuses the hint normalization (`;`/`_` → space) so the stored
    // column matches what the card renders.
    expect(fields.cuisine).toBe('czech beer');
    // Street + house number are combined into one human-readable line.
    expect(fields.address_street).toBe('Křemencova 11');
    expect(fields.address_city).toBe('Praha');
    expect(fields.address_postcode).toBe('110 00');
    // `addr:country` is normalized to an upper-case ISO-2 code for the
    // varchar(2) column.
    expect(fields.address_country).toBe('CZ');
  });

  it('prefers brand over operator for the fuel/chain identity', () => {
    expect(
      extractStoredPoiFields({ brand: 'Shell', operator: 'Shell CZ' }).brand,
    ).toBe('Shell');
    expect(extractStoredPoiFields({ operator: 'Local Co-op' }).brand).toBe(
      'Local Co-op',
    );
  });

  it('falls back city → town → village for the address city', () => {
    // Motorcyclists ride rural: an OSM POI often only has addr:town or
    // addr:village, so we fall through rather than dropping the location.
    expect(extractStoredPoiFields({ 'addr:town': 'Rožnov' }).address_city).toBe(
      'Rožnov',
    );
    expect(
      extractStoredPoiFields({ 'addr:village': 'Prostřední Bečva' })
        .address_city,
    ).toBe('Prostřední Bečva');
  });

  it('drops a non-two-letter country code rather than storing garbage', () => {
    expect(
      extractStoredPoiFields({ 'addr:country': 'Czechia' }).address_country,
    ).toBeNull();
    expect(
      extractStoredPoiFields({ 'addr:country': 'C' }).address_country,
    ).toBeNull();
  });

  it('leaves address_street null when only a house number is tagged', () => {
    // A bare house number with no street is useless on a card.
    expect(
      extractStoredPoiFields({ 'addr:housenumber': '11' }).address_street,
    ).toBeNull();
  });

  it('returns nulls and a null tag bag when there are no tags', () => {
    expect(extractStoredPoiFields({})).toEqual({
      opening_hours: null,
      address_street: null,
      address_city: null,
      address_postcode: null,
      address_country: null,
      cuisine: null,
      brand: null,
      tags: null,
    });
  });

  it('keeps a raw tag bag for future enrichment', () => {
    expect(
      extractStoredPoiFields({ amenity: 'restaurant', wheelchair: 'yes' }).tags,
    ).toEqual({ amenity: 'restaurant', wheelchair: 'yes' });
  });

  it('bounds the tag bag: caps the key count and truncates huge values', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`k${String(i).padStart(3, '0')}`] = 'v';
    many.huge = 'x'.repeat(1000);
    const bag = extractStoredPoiFields(many).tags!;
    expect(Object.keys(bag).length).toBeLessThanOrEqual(60);
    // 'huge' sorts before the 'k***' keys, so it survives the cap and is
    // truncated to the max value length.
    expect(bag.huge!.length).toBe(512);
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

  it('adds `extraLimit` to the `out` cap so the frontier merge can survive duplicates (#945)', async () => {
    const provider = new OverpassPoiProvider(config);
    await provider.findPointsOfInterestAroundPoints(
      [{ lat: 49, lng: 16.75 }],
      2,
      ['restaurant'],
      45,
    );
    expect(capturedBody).not.toBeNull();
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    // 200 base cap + 45 extra.
    expect(decoded).toContain('out center tags 245;');
  });

  it('uses the plain base cap when no extraLimit is given', async () => {
    const provider = new OverpassPoiProvider(config);
    await provider.findPointsOfInterestAroundPoints(
      [{ lat: 49, lng: 16.75 }],
      2,
      ['restaurant'],
    );
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    expect(decoded).toContain('out center tags 200;');
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

describe('OverpassPoiProvider.findImportPoisInBbox', () => {
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

  it('queries the full §7 storage tag set across amenity/tourism/highway/shop', async () => {
    const provider = new OverpassPoiProvider(config);
    await provider.findImportPoisInBbox({
      minLng: 18,
      minLat: 49.3,
      maxLng: 18.9,
      maxLat: 49.75,
    });

    expect(capturedBody).not.toBeNull();
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    // Overpass bbox order is south,west,north,east.
    expect(decoded).toContain('(49.3,18,49.75,18.9)');
    // The documented superset, not just the live POI_KINDS.
    expect(decoded).toMatch(
      /amenity"~"\^\((restaurant|cafe|fast_food|fuel|ice_cream)(\|(restaurant|cafe|fast_food|fuel|ice_cream))*\)/,
    );
    expect(decoded).toContain('fast_food');
    expect(decoded).toContain('tourism"~"^(viewpoint)$"');
    expect(decoded).toContain('highway"~"^(rest_area|services)$"');
    expect(decoded).toContain('shop"~"^(ice_cream)$"');
    // node + way + relation — multipolygon rest areas / viewpoint sites
    // are modeled as relations.
    expect(decoded).toContain('node["tourism"~"^(viewpoint)$"]');
    expect(decoded).toContain('way["tourism"~"^(viewpoint)$"]');
    expect(decoded).toContain('relation["tourism"~"^(viewpoint)$"]');
  });

  it('maps each element to its §7 kind (incl. highway services → rest_area)', async () => {
    const elements = [
      {
        type: 'node',
        id: 1,
        lat: 49.5,
        lon: 18.4,
        tags: { amenity: 'fast_food', name: 'Burger' },
      },
      {
        type: 'way',
        id: 2,
        center: { lat: 49.6, lon: 18.5 },
        tags: { highway: 'services', name: 'Rest' },
      },
      {
        type: 'node',
        id: 3,
        lat: 49.7,
        lon: 18.6,
        tags: { shop: 'ice_cream' },
      },
    ];
    const fetchStub = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ elements }),
    });
    globalThis.fetch = fetchStub;
    const provider = new OverpassPoiProvider(config);
    const result = await provider.findImportPoisInBbox({
      minLng: 18,
      minLat: 49.3,
      maxLng: 18.9,
      maxLat: 49.75,
    });
    expect(result.map((p) => p.kind)).toEqual([
      'fast_food',
      'rest_area',
      'ice_cream',
    ]);
    expect(result[0]!.external_id).toBe('osm:node:1');
  });

  it('captures decision-support fields (hours/address/cuisine/tags) on imported POIs', async () => {
    const elements = [
      {
        type: 'node',
        id: 7,
        lat: 49.5,
        lon: 18.4,
        tags: {
          amenity: 'restaurant',
          name: 'Koliba',
          opening_hours: 'Mo-Su 11:00-22:00',
          cuisine: 'regional',
          'addr:city': 'Rožnov',
          'addr:country': 'cz',
        },
      },
    ];
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ elements }),
    });
    const provider = new OverpassPoiProvider(config);
    const [p] = await provider.findImportPoisInBbox({
      minLng: 18,
      minLat: 49.3,
      maxLng: 18.9,
      maxLat: 49.75,
    });
    expect(p!.opening_hours).toBe('Mo-Su 11:00-22:00');
    expect(p!.address_city).toBe('Rožnov');
    expect(p!.address_country).toBe('CZ');
    expect(p!.cuisine).toBe('regional');
    expect(p!.tags).toMatchObject({ amenity: 'restaurant' });
  });

  it('queries tourism accommodations in a bbox (node/way/relation)', async () => {
    const provider = new OverpassPoiProvider(config);
    await provider.findAccommodationsInBbox(
      { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
      ['hotel', 'camp_site'],
    );
    expect(capturedBody).not.toBeNull();
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ''));
    expect(decoded).toContain('(49.3,18,49.75,18.9)');
    expect(decoded).toContain('node["tourism"~"^(hotel|camp_site)$"]');
    expect(decoded).toContain('way["tourism"~"^(hotel|camp_site)$"]');
    expect(decoded).toContain('relation["tourism"~"^(hotel|camp_site)$"]');
  });

  it('short-circuits accommodations on zero kinds (no fetch)', async () => {
    const provider = new OverpassPoiProvider(config);
    const result = await provider.findAccommodationsInBbox(
      { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
      [],
    );
    expect(result).toEqual([]);
    expect(capturedBody).toBeNull();
  });
});
