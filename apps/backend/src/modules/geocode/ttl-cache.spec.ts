import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  it('returns a set value and undefined for a missing key', () => {
    const cache = new TtlCache<number>(10, 1000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires an entry once the TTL has elapsed', () => {
    let clock = 0;
    const cache = new TtlCache<string>(10, 1000, () => clock);
    cache.set('k', 'v');

    clock = 999;
    expect(cache.get('k')).toBe('v'); // still fresh

    clock = 1000;
    expect(cache.get('k')).toBeUndefined(); // expiresAt <= now → expired
    expect(cache.size).toBe(0); // and dropped on read
  });

  it('evicts the oldest entry once over capacity', () => {
    const cache = new TtlCache<number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // over cap → evict oldest ('a')

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('a get refreshes recency so the touched entry survives eviction', () => {
    const cache = new TtlCache<number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' becomes most-recent → 'b' is now the oldest
    cache.set('c', 3); // evicts 'b', not 'a'

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });
});
