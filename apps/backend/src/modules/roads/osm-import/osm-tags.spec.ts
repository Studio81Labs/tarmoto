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

  it('rejects restricted-but-not-"no" access values (allowlist)', () => {
    for (const v of [
      'agricultural',
      'forestry',
      'delivery',
      'customers',
      'permit',
    ]) {
      expect(isDrivableHighway({ highway: 'track', access: v })).toBe(false);
    }
  });

  it('accepts the public-access values + destination', () => {
    for (const v of [
      'yes',
      'permissive',
      'designated',
      'public',
      'destination',
    ]) {
      expect(isDrivableHighway({ highway: 'residential', access: v })).toBe(
        true,
      );
    }
  });

  it('honours a specific motorcycle allow over a broad restriction', () => {
    // OSM precedence: the most-specific key present wins.
    expect(
      isDrivableHighway({
        highway: 'residential',
        access: 'no',
        motorcycle: 'yes',
      }),
    ).toBe(true);
  });

  it('honours a specific motorcycle restriction over a broad allow', () => {
    expect(
      isDrivableHighway({ highway: 'track', access: 'yes', motorcycle: 'no' }),
    ).toBe(false);
  });

  it('rejects private service subtypes (driveway / parking aisle) without explicit access', () => {
    for (const s of ['driveway', 'parking_aisle', 'drive-through']) {
      expect(isDrivableHighway({ highway: 'service', service: s })).toBe(false);
    }
    // …but accepts them with an explicit public access value.
    expect(
      isDrivableHighway({
        highway: 'service',
        service: 'driveway',
        access: 'yes',
      }),
    ).toBe(true);
  });

  it('still accepts generic service ways (no private subtype)', () => {
    expect(isDrivableHighway({ highway: 'service' })).toBe(true);
    expect(isDrivableHighway({ highway: 'service', service: 'alley' })).toBe(
      true,
    );
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

  it('clamps overlong name / ref to the column limits (untrusted OSM input)', () => {
    const fields = roadFieldsFromTags({
      name: 'a'.repeat(400),
      ref: 'b'.repeat(120),
    });
    expect(fields.road_name).toHaveLength(255);
    expect(fields.road_number).toHaveLength(50);
  });

  it('trims and treats blank tags as absent', () => {
    expect(roadFieldsFromTags({ name: '  Main St  ' }).road_name).toBe(
      'Main St',
    );
    const blank = roadFieldsFromTags({ name: '   ', ref: '' });
    expect(blank.road_name).toBeNull();
    expect(blank.road_number).toBeNull();
  });
});
