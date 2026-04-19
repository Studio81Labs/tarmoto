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

  it('ignores unrelated amenities and tourism values', () => {
    expect(classifyPoiTags({ amenity: 'bar' })).toBeNull();
    expect(classifyPoiTags({ tourism: 'hotel' })).toBeNull();
    expect(classifyPoiTags({})).toBeNull();
  });

  it('prefers amenity classification over tourism when both are present', () => {
    // Real-world data: a restaurant with tourism=viewpoint nearby tags.
    // Amenity always wins so the row keeps its primary category.
    expect(
      classifyPoiTags({ amenity: 'restaurant', tourism: 'viewpoint' }),
    ).toBe('restaurant');
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
  });
});
