import { graphhopperReimportConfig } from './graphhopper-reimport.config.js';

/** Env keys this config reads — saved/restored around each case. */
const KEYS = [
  'TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL',
  'TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_TOKEN',
  'TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD',
];

describe('graphhopperReimportConfig', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to a disabled no-op (no URL, POST)', () => {
    expect(graphhopperReimportConfig()).toEqual({
      webhookUrl: null,
      token: null,
      method: 'POST',
    });
  });

  it('parses a valid https webhook with token and GET method', () => {
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL =
      'https://coolify.example.com/api/v1/deploy?uuid=abc';
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_TOKEN = 'tok';
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD = 'get';
    expect(graphhopperReimportConfig()).toEqual({
      webhookUrl: 'https://coolify.example.com/api/v1/deploy?uuid=abc',
      token: 'tok',
      method: 'GET',
    });
  });

  it('rejects an unsupported method', () => {
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD = 'DELETE';
    expect(() => graphhopperReimportConfig()).toThrow(/must be POST or GET/);
  });

  it('rejects a malformed URL without echoing the raw value (no token leak)', () => {
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL =
      'ht!tp://bad url?token=SECRET';
    expect(() => graphhopperReimportConfig()).toThrow(/must be a valid URL/);
    try {
      graphhopperReimportConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });

  it('rejects a non-http(s) URL without echoing the raw value', () => {
    process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL =
      'ftp://host/path?token=SECRET';
    expect(() => graphhopperReimportConfig()).toThrow(
      /must be an http\(s\) URL/,
    );
    try {
      graphhopperReimportConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});
