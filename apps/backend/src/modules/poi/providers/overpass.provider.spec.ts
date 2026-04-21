import {
  classifyPoiTags,
  extractPoiHint,
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
