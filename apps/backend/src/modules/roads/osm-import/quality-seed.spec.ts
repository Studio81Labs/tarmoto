import {
  qualitySeedFromTags,
  QUALITY_SEED_PRIOR_WEIGHT,
} from './quality-seed.js';

describe('qualitySeedFromTags', () => {
  it('maps smoothness (inverse of ADR-0005), clamping worse-than-scale tiers to 1', () => {
    expect(qualitySeedFromTags({ smoothness: 'excellent' })).toEqual({
      score: 5,
      source: 'osm_smoothness',
    });
    expect(qualitySeedFromTags({ smoothness: 'good' })).toEqual({
      score: 4,
      source: 'osm_smoothness',
    });
    expect(qualitySeedFromTags({ smoothness: 'intermediate' })).toEqual({
      score: 3,
      source: 'osm_smoothness',
    });
    expect(qualitySeedFromTags({ smoothness: 'bad' })).toEqual({
      score: 2,
      source: 'osm_smoothness',
    });
    for (const s of ['very_bad', 'horrible', 'very_horrible', 'impassable']) {
      expect(qualitySeedFromTags({ smoothness: s })).toEqual({
        score: 1,
        source: 'osm_smoothness',
      });
    }
  });

  it('falls back to surface when smoothness is absent/unknown', () => {
    expect(qualitySeedFromTags({ surface: 'asphalt' })).toEqual({
      score: 4,
      source: 'osm_surface',
    });
    expect(qualitySeedFromTags({ surface: 'compacted' })).toEqual({
      score: 3,
      source: 'osm_surface',
    });
    expect(qualitySeedFromTags({ surface: 'gravel' })).toEqual({
      score: 2,
      source: 'osm_surface',
    });
    expect(qualitySeedFromTags({ surface: 'mud' })).toEqual({
      score: 1,
      source: 'osm_surface',
    });
    // Unknown smoothness value → not matched → falls through to surface.
    expect(
      qualitySeedFromTags({ smoothness: 'weird', surface: 'asphalt' }),
    ).toEqual({ score: 4, source: 'osm_surface' });
  });

  it('falls back to highway class when smoothness and surface are absent (+_link normalised)', () => {
    expect(qualitySeedFromTags({ highway: 'motorway' })).toEqual({
      score: 4,
      source: 'osm_highway',
    });
    expect(qualitySeedFromTags({ highway: 'secondary_link' })).toEqual({
      score: 4,
      source: 'osm_highway',
    });
    expect(qualitySeedFromTags({ highway: 'residential' })).toEqual({
      score: 3,
      source: 'osm_highway',
    });
    expect(qualitySeedFromTags({ highway: 'track' })).toEqual({
      score: 2,
      source: 'osm_highway',
    });
  });

  it('precedence: smoothness beats surface beats highway', () => {
    expect(
      qualitySeedFromTags({
        smoothness: 'bad',
        surface: 'asphalt',
        highway: 'motorway',
      }),
    ).toEqual({ score: 2, source: 'osm_smoothness' });
    expect(
      qualitySeedFromTags({ surface: 'gravel', highway: 'motorway' }),
    ).toEqual({ score: 2, source: 'osm_surface' });
  });

  it('returns {null,null} when nothing matches', () => {
    expect(qualitySeedFromTags({})).toEqual({ score: null, source: null });
    expect(qualitySeedFromTags({ highway: 'proposed' })).toEqual({
      score: null,
      source: null,
    });
  });

  it('exports the prior weight k=4 matching the SQL literal', () => {
    expect(QUALITY_SEED_PRIOR_WEIGHT).toBe(4);
  });
});
