import { googleMapsUrl, osmDetailUrl } from './poi-links.js';

describe('osmDetailUrl', () => {
  it('builds node/way/relation OSM URLs from the external id', () => {
    expect(osmDetailUrl('osm:node:123')).toBe(
      'https://www.openstreetmap.org/node/123',
    );
    expect(osmDetailUrl('osm:way:456')).toBe(
      'https://www.openstreetmap.org/way/456',
    );
    expect(osmDetailUrl('osm:relation:789')).toBe(
      'https://www.openstreetmap.org/relation/789',
    );
  });

  it('returns null for a non-OSM or malformed external id', () => {
    expect(osmDetailUrl('overture:place:abc')).toBeNull();
    expect(osmDetailUrl('osm:node:')).toBeNull();
    expect(osmDetailUrl('osm:building:1')).toBeNull();
    expect(osmDetailUrl('node/1')).toBeNull();
  });
});

describe('googleMapsUrl', () => {
  it('builds a name + coordinate query with no API key', () => {
    expect(googleMapsUrl('Koliba', 49.5, 18.4)).toBe(
      'https://www.google.com/maps/search/?api=1&query=Koliba%2049.5%2C18.4',
    );
  });

  it('falls back to the coordinate alone when the POI is unnamed', () => {
    const expected =
      'https://www.google.com/maps/search/?api=1&query=49.5%2C18.4';
    expect(googleMapsUrl(null, 49.5, 18.4)).toBe(expected);
    expect(googleMapsUrl('   ', 49.5, 18.4)).toBe(expected);
  });

  it('url-encodes names with spaces and diacritics', () => {
    const url = googleMapsUrl('Café U Fleků', 50.08, 14.42);
    expect(url).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(url).toContain(encodeURIComponent('Café U Fleků 50.08,14.42'));
  });
});
