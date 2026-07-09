import {
  classifyImportPoiKind,
  mapOsmElementToPoi,
  matchAccommodationKind,
  toAccommodationPoi,
  toImportedPoi,
  type OsmPoiElement,
} from './osm-poi-tags.js';
import type {
  AccommodationPoi,
  ImportedPoi,
} from '../poi-provider.interface.js';

/** Build a normalized element, overriding fields per-test. */
function el(partial: Partial<OsmPoiElement>): OsmPoiElement {
  return {
    osmType: 'node',
    osmId: 1,
    lat: 49.5,
    lng: 18.4,
    tags: {},
    ...partial,
  };
}

function expectPoi(result: ReturnType<typeof mapOsmElementToPoi>): ImportedPoi {
  if (!result || !('poi' in result)) {
    throw new Error(`expected a POI result, got ${JSON.stringify(result)}`);
  }
  return result.poi;
}

function expectAccommodation(
  result: ReturnType<typeof mapOsmElementToPoi>,
): AccommodationPoi {
  if (!result || !('accommodation' in result)) {
    throw new Error(
      `expected an accommodation result, got ${JSON.stringify(result)}`,
    );
  }
  return result.accommodation;
}

describe('mapOsmElementToPoi', () => {
  it('maps a fuel node to a fuel_station POI with an osm node external_id', () => {
    const poi = expectPoi(
      mapOsmElementToPoi(el({ osmId: 42, tags: { amenity: 'fuel' } })),
    );
    expect(poi.kind).toBe('fuel_station');
    expect(poi.external_id).toBe('osm:node:42');
    expect(poi.lat).toBe(49.5);
    expect(poi.lng).toBe(18.4);
  });

  it('maps a restaurant with cuisine + address into StoredPoiFields', () => {
    const poi = expectPoi(
      mapOsmElementToPoi(
        el({
          tags: {
            amenity: 'restaurant',
            name: 'Koliba',
            cuisine: 'regional;grill',
            opening_hours: 'Mo-Su 11:00-22:00',
            'addr:street': 'Křemencova',
            'addr:housenumber': '11',
            'addr:city': 'Rožnov',
            'addr:postcode': '756 61',
            'addr:country': 'cz',
            website: 'https://koliba.example',
            phone: '+420 555 123 456',
          },
        }),
      ),
    );
    expect(poi.kind).toBe('restaurant');
    expect(poi.name).toBe('Koliba');
    // `;`/`_` collapse to spaces so the stored column matches the card.
    expect(poi.cuisine).toBe('regional grill');
    expect(poi.opening_hours).toBe('Mo-Su 11:00-22:00');
    // Street + house number combined into one line.
    expect(poi.address_street).toBe('Křemencova 11');
    expect(poi.address_city).toBe('Rožnov');
    expect(poi.address_postcode).toBe('756 61');
    // ISO-2 country upper-cased.
    expect(poi.address_country).toBe('CZ');
    expect(poi.website).toBe('https://koliba.example');
    expect(poi.phone).toBe('+420 555 123 456');
    expect(poi.tags).toMatchObject({ amenity: 'restaurant' });
  });

  it('keeps the classifier tags (amenity/tourism) even when the tag bag is capped (#926)', () => {
    // 65 filler keys sort between `amenity` and `tourism`, so the 60-key cap
    // would truncate `tourism=viewpoint` — but the store read's secondary-kind
    // match relies on it, so the classifier keys are prioritised past the cap.
    const filler: Record<string, string> = {};
    for (let i = 0; i < 65; i++) {
      filler[`contact:${String(i).padStart(2, '0')}`] = 'x';
    }
    const poi = expectPoi(
      mapOsmElementToPoi(
        el({
          tags: { amenity: 'restaurant', tourism: 'viewpoint', ...filler },
        }),
      ),
    );
    expect(poi.tags?.amenity).toBe('restaurant');
    expect(poi.tags?.tourism).toBe('viewpoint');
  });

  it('maps a fast_food node to the fast_food store kind (superset of the live enum)', () => {
    const poi = expectPoi(
      mapOsmElementToPoi(
        el({ tags: { amenity: 'fast_food', name: 'Burger' } }),
      ),
    );
    expect(poi.kind).toBe('fast_food');
  });

  it('maps a hotel with a stars tag to an accommodation with a parsed rating', () => {
    const acc = expectAccommodation(
      mapOsmElementToPoi(
        el({
          osmType: 'way',
          osmId: 7,
          tags: { tourism: 'hotel', name: 'Horský', stars: '4S' },
        }),
      ),
    );
    expect(acc.kind).toBe('hotel');
    expect(acc.stars).toBe(4);
    expect(acc.external_id).toBe('osm:way:7');
  });

  it('drops brand back to operator for the chain identity', () => {
    expect(
      expectPoi(
        mapOsmElementToPoi(
          el({
            tags: { amenity: 'fuel', brand: 'Shell', operator: 'Shell CZ' },
          }),
        ),
      ).brand,
    ).toBe('Shell');
    expect(
      expectPoi(
        mapOsmElementToPoi(
          el({ tags: { amenity: 'fuel', operator: 'Local Co-op' } }),
        ),
      ).brand,
    ).toBe('Local Co-op');
  });

  it('drops a non-two-letter country code rather than storing garbage', () => {
    expect(
      expectPoi(
        mapOsmElementToPoi(
          el({ tags: { amenity: 'cafe', 'addr:country': 'Czechia' } }),
        ),
      ).address_country,
    ).toBeNull();
  });

  it('returns null for an untagged or irrelevant element', () => {
    expect(mapOsmElementToPoi(el({ tags: {} }))).toBeNull();
    expect(mapOsmElementToPoi(el({ tags: { amenity: 'bar' } }))).toBeNull();
    expect(
      mapOsmElementToPoi(el({ tags: { tourism: 'attraction' } })),
    ).toBeNull();
  });

  it('prefers accommodation over a co-tagged POI (hotel-restaurant → hotel row)', () => {
    // The Overpass import path dedupes POIs-then-accommodations by external_id
    // with the accommodation added last, so a both-tagged element lands as the
    // hotel. The single-pass extract must reproduce that precedence.
    const acc = expectAccommodation(
      mapOsmElementToPoi(
        el({ tags: { amenity: 'restaurant', tourism: 'hotel', stars: '3' } }),
      ),
    );
    expect(acc.kind).toBe('hotel');
    expect(acc.stars).toBe(3);
  });

  it('breaks a POI-set tie by IMPORT_POI_TAGS order (amenity before highway)', () => {
    const poi = expectPoi(
      mapOsmElementToPoi(
        el({ tags: { amenity: 'fuel', highway: 'services' } }),
      ),
    );
    expect(poi.kind).toBe('fuel_station');
  });

  it('maps highway=services to rest_area (both service tags collapse there)', () => {
    expect(
      expectPoi(mapOsmElementToPoi(el({ tags: { highway: 'services' } }))).kind,
    ).toBe('rest_area');
    expect(
      expectPoi(mapOsmElementToPoi(el({ tags: { highway: 'rest_area' } })))
        .kind,
    ).toBe('rest_area');
  });

  it('falls back name → name:en', () => {
    expect(
      expectPoi(
        mapOsmElementToPoi(
          el({ tags: { amenity: 'cafe', 'name:en': 'Old Town Café' } }),
        ),
      ).name,
    ).toBe('Old Town Café');
  });
});

describe('classifyImportPoiKind', () => {
  it('returns the §7 kind for a matching tag, null otherwise', () => {
    expect(classifyImportPoiKind({ amenity: 'restaurant' })).toBe('restaurant');
    expect(classifyImportPoiKind({ shop: 'ice_cream' })).toBe('ice_cream');
    expect(classifyImportPoiKind({ tourism: 'viewpoint' })).toBe('viewpoint');
    expect(classifyImportPoiKind({ tourism: 'hotel' })).toBeNull();
    expect(classifyImportPoiKind({})).toBeNull();
  });
});

describe('matchAccommodationKind', () => {
  it('accepts the ACCOMMODATION_KINDS set and rejects others', () => {
    expect(matchAccommodationKind({ tourism: 'camp_site' })).toBe('camp_site');
    expect(matchAccommodationKind({ tourism: 'guest_house' })).toBe(
      'guest_house',
    );
    // A POI tourism value is not an accommodation.
    expect(matchAccommodationKind({ tourism: 'viewpoint' })).toBeNull();
    expect(matchAccommodationKind({})).toBeNull();
  });
});

describe('toImportedPoi / toAccommodationPoi', () => {
  it('toImportedPoi returns null for an accommodation-only element', () => {
    expect(toImportedPoi(el({ tags: { tourism: 'hotel' } }))).toBeNull();
  });

  it('toAccommodationPoi returns null for a POI-only element', () => {
    expect(toAccommodationPoi(el({ tags: { amenity: 'fuel' } }))).toBeNull();
  });
});
