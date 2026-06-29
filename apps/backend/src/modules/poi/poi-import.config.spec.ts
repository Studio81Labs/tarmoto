import { poiImportConfig } from './poi-import.config.js';

describe('poiImportConfig', () => {
  const KEY = 'TARMOTO_POI_IMPORT_BBOX';
  const ENABLED = 'TARMOTO_POI_IMPORT_ENABLED';
  let savedBbox: string | undefined;
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedBbox = process.env[KEY];
    savedEnabled = process.env[ENABLED];
    delete process.env[KEY];
    delete process.env[ENABLED];
  });

  afterEach(() => {
    if (savedBbox === undefined) delete process.env[KEY];
    else process.env[KEY] = savedBbox;
    if (savedEnabled === undefined) delete process.env[ENABLED];
    else process.env[ENABLED] = savedEnabled;
  });

  it('defaults bbox to CZ/Beskydy when unset, disabled', () => {
    const cfg = poiImportConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.bbox).toEqual({
      minLng: 18.0,
      minLat: 49.3,
      maxLng: 18.9,
      maxLat: 49.75,
    });
  });

  it('parses a valid bbox and the enabled flag', () => {
    process.env[KEY] = '14.0,48.5,17.0,51.0';
    process.env[ENABLED] = 'true';
    const cfg = poiImportConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.bbox).toEqual({
      minLng: 14.0,
      minLat: 48.5,
      maxLng: 17.0,
      maxLat: 51.0,
    });
  });

  it('throws on a present-but-malformed bbox instead of silently defaulting', () => {
    process.env[KEY] = '14.0,48.5,17.0'; // only 3 parts
    expect(() => poiImportConfig()).toThrow(/Invalid TARMOTO_POI_IMPORT_BBOX/);
  });

  it('throws when min >= max (degenerate box)', () => {
    process.env[KEY] = '17.0,48.5,14.0,51.0'; // minLng > maxLng
    expect(() => poiImportConfig()).toThrow(/Invalid TARMOTO_POI_IMPORT_BBOX/);
  });
});
