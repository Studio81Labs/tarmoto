import { DEFAULT_REGIONS } from './poi-import.config.js';
import {
  GEOFABRIK_SLUGS,
  POI_TAGS_FILTER_EXPRESSIONS,
  bboxArg,
  geofabrikUrl,
  resolvePoiRefreshConfig,
} from './poi-refresh.config.js';

describe('poi-refresh.config', () => {
  it('has a Geofabrik slug for every configured region, and no stray slugs (#976 drift guard)', () => {
    const missing = DEFAULT_REGIONS.filter((r) => !GEOFABRIK_SLUGS[r.code]).map(
      (r) => r.code,
    );
    expect(missing).toEqual([]);

    const codes = new Set(DEFAULT_REGIONS.map((r) => r.code));
    const stray = Object.keys(GEOFABRIK_SLUGS).filter((c) => !codes.has(c));
    expect(stray).toEqual([]);
  });

  it('builds the europe/<slug>-latest.osm.pbf URL; null for an unknown code', () => {
    expect(geofabrikUrl('CZ')).toBe(
      'https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf',
    );
    expect(geofabrikUrl('ZZ')).toBeNull();
  });

  it('bboxArg is minLng,minLat,maxLng,maxLat — osmium extract -b order', () => {
    expect(
      bboxArg({ minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 }),
    ).toBe('12.09,48.55,18.86,51.06');
  });

  it('tags-filter is the §7 superset (fast_food, ice cream, camp_site, rest areas)', () => {
    const joined = POI_TAGS_FILTER_EXPRESSIONS.join(' ');
    expect(joined).toContain(
      'amenity=fuel,restaurant,cafe,fast_food,ice_cream',
    );
    expect(joined).toContain('camp_site');
    expect(joined).toContain('viewpoint');
    expect(joined).toContain('highway=rest_area,services');
    expect(joined).toContain('shop=ice_cream');
  });

  describe('resolvePoiRefreshConfig', () => {
    it('is disabled with all regions by default', () => {
      const cfg = resolvePoiRefreshConfig({
        TARMOTO_POI_IMPORT_DIR: '/data',
      });

      expect(cfg.enabled).toBe(false);
      expect(cfg.targetDir).toBe('/data');
      expect(cfg.regions).toHaveLength(DEFAULT_REGIONS.length);
    });

    it('enables on TARMOTO_POI_REFRESH_ENABLED=true and narrows to (case-insensitive) TARMOTO_POI_IMPORT_REGIONS', () => {
      const cfg = resolvePoiRefreshConfig({
        TARMOTO_POI_REFRESH_ENABLED: 'true',
        TARMOTO_POI_IMPORT_DIR: '/data',
        TARMOTO_POI_IMPORT_REGIONS: 'cz, sk , AT',
      });

      expect(cfg.enabled).toBe(true);
      // kept in DEFAULT_REGIONS order regardless of request order/case
      expect(cfg.regions.map((r) => r.code)).toEqual(['CZ', 'SK', 'AT']);
    });

    it('targetDir is null when TARMOTO_POI_IMPORT_DIR is unset', () => {
      expect(resolvePoiRefreshConfig({}).targetDir).toBeNull();
    });

    it('fails fast on an unknown region code instead of silently dropping it (#976 review)', () => {
      expect(() =>
        resolvePoiRefreshConfig({ TARMOTO_POI_IMPORT_REGIONS: 'CZ,ZZ' }),
      ).toThrow(/unknown region "ZZ"/);
    });
  });
});
