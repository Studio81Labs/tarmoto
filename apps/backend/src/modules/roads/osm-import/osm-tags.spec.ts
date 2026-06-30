import {
  isDrivableHighway,
  roadFieldsFromTags,
  surfaceSeedFromTag,
} from './osm-tags.js';

describe('isDrivableHighway', () => {
  it('accepts drivable road classes', () => {
    for (const hw of [
      'motorway',
      'primary',
      'residential',
      'track',
      'service',
    ]) {
      expect(isDrivableHighway({ highway: hw })).toBe(true);
    }
  });

  it('rejects non-road ways', () => {
    for (const hw of ['footway', 'cycleway', 'path', 'pedestrian', 'steps']) {
      expect(isDrivableHighway({ highway: hw })).toBe(false);
    }
    expect(isDrivableHighway({})).toBe(false);
  });

  it('rejects ways closed on any motorcycle access key', () => {
    for (const key of ['access', 'vehicle', 'motor_vehicle', 'motorcycle']) {
      expect(isDrivableHighway({ highway: 'residential', [key]: 'no' })).toBe(
        false,
      );
    }
  });

  it('rejects ways with a private access value (driveways / forestry)', () => {
    for (const key of ['access', 'vehicle', 'motor_vehicle', 'motorcycle']) {
      expect(isDrivableHighway({ highway: 'track', [key]: 'private' })).toBe(
        false,
      );
    }
  });

  it('still accepts a drivable way with a destination access value', () => {
    expect(
      isDrivableHighway({ highway: 'residential', access: 'destination' }),
    ).toBe(true);
  });
});

describe('surfaceSeedFromTag', () => {
  it('maps paved variants to asphalt', () => {
    for (const s of ['asphalt', 'paved', 'tarmac', 'chipseal']) {
      expect(surfaceSeedFromTag(s)).toBe('asphalt');
    }
  });

  it('maps the coarse buckets', () => {
    expect(surfaceSeedFromTag('concrete')).toBe('concrete');
    expect(surfaceSeedFromTag('paving_stones')).toBe('cobblestone');
    expect(surfaceSeedFromTag('gravel')).toBe('gravel');
    expect(surfaceSeedFromTag('unpaved')).toBe('gravel'); // generic not-asphalt
    expect(surfaceSeedFromTag('dirt')).toBe('dirt');
    expect(surfaceSeedFromTag('ground')).toBe('dirt');
  });

  it('defaults to unknown for missing / unrecognised surfaces', () => {
    expect(surfaceSeedFromTag(undefined)).toBe('unknown');
    expect(surfaceSeedFromTag('something_weird')).toBe('unknown');
  });
});

describe('roadFieldsFromTags', () => {
  it('derives name / number / surface seed', () => {
    expect(
      roadFieldsFromTags({ name: 'Hlavní', ref: 'D1', surface: 'asphalt' }),
    ).toEqual({
      road_name: 'Hlavní',
      road_number: 'D1',
      surface_type: 'asphalt',
    });
  });

  it('falls back to name:en and nulls for absent tags', () => {
    expect(roadFieldsFromTags({ 'name:en': 'Main St' }).road_name).toBe(
      'Main St',
    );
    const empty = roadFieldsFromTags({});
    expect(empty.road_name).toBeNull();
    expect(empty.road_number).toBeNull();
    expect(empty.surface_type).toBe('unknown');
  });
});
