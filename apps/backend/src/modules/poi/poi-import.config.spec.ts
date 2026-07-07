import { DEFAULT_REGIONS, poiImportConfig } from './poi-import.config.js';

describe('poiImportConfig', () => {
  const ENABLED = 'TARMOTO_POI_IMPORT_ENABLED';
  const DIR = 'TARMOTO_POI_IMPORT_DIR';
  const REGIONS = 'TARMOTO_POI_IMPORT_REGIONS';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [ENABLED, DIR, REGIONS]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to disabled, no extract dir, and the full 17-region coverage list', () => {
    const cfg = poiImportConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.extractDir).toBeNull();
    expect(cfg.regions).toHaveLength(17);
    expect(cfg.regions.map((r) => r.code)).toEqual(
      DEFAULT_REGIONS.map((r) => r.code),
    );
  });

  it('reads the enabled flag and the extract dir', () => {
    process.env[ENABLED] = 'true';
    process.env[DIR] = '/data/poi-extracts';
    const cfg = poiImportConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.extractDir).toBe('/data/poi-extracts');
  });

  it('narrows the coverage list to the selected regions, in order, deduped', () => {
    process.env[REGIONS] = 'sk, cz , CZ';
    const cfg = poiImportConfig();
    expect(cfg.regions.map((r) => r.code)).toEqual(['SK', 'CZ']);
    // The bbox comes from the authoritative default, not the env.
    expect(cfg.regions[0]?.bbox).toEqual(
      DEFAULT_REGIONS.find((r) => r.code === 'SK')?.bbox,
    );
  });

  it('falls back to the full list when the region list is blank', () => {
    process.env[REGIONS] = '  ';
    expect(poiImportConfig().regions).toHaveLength(17);
  });

  it('throws on an unknown region code instead of silently skipping it', () => {
    process.env[REGIONS] = 'CZ,ZZ';
    expect(() => poiImportConfig()).toThrow(
      /Invalid TARMOTO_POI_IMPORT_REGIONS: unknown region "ZZ"/,
    );
  });

  it('every default region carries a non-degenerate bbox with a valid code', () => {
    for (const { code, bbox } of DEFAULT_REGIONS) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(bbox.maxLng - bbox.minLng).toBeGreaterThan(0);
      expect(bbox.maxLat - bbox.minLat).toBeGreaterThan(0);
    }
  });
});
