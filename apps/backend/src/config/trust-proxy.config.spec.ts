import { loadTrustProxyConfig } from './trust-proxy.config.js';

describe('loadTrustProxyConfig', () => {
  it('defaults to 0 hops when env var is unset', () => {
    expect(loadTrustProxyConfig({})).toEqual({ hops: 0 });
  });

  it('defaults to 0 hops when env var is empty or whitespace', () => {
    expect(loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '' })).toEqual({
      hops: 0,
    });
    expect(loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '   ' })).toEqual({
      hops: 0,
    });
  });

  it('parses a positive integer', () => {
    expect(loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '1' })).toEqual({
      hops: 1,
    });
    expect(loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '2' })).toEqual({
      hops: 2,
    });
  });

  it('accepts 0 explicitly', () => {
    expect(loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '0' })).toEqual({
      hops: 0,
    });
  });

  it('rejects negative numbers', () => {
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '-1' }),
    ).toThrow(/non-negative integer/);
  });

  it('rejects non-integer values', () => {
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '1.5' }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: 'true' }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: '1 proxy' }),
    ).toThrow(/non-negative integer/);
  });

  it('rejects boolean-like strings to prevent accidental `trust proxy: true`', () => {
    // Explicitly reject these — they would be dangerously permissive if Express
    // interpreted them as truthy.
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: 'true' }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      loadTrustProxyConfig({ TARMOTO_TRUST_PROXY_HOPS: 'all' }),
    ).toThrow(/non-negative integer/);
  });
});
