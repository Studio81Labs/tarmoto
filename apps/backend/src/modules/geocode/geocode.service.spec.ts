import { Test, TestingModule } from '@nestjs/testing';
import { GeocodeService } from './geocode.service.js';
import {
  GEOCODE_PROVIDER,
  type GeocodeProvider,
  type GeocodeResult,
} from './geocode-provider.interface.js';

describe('GeocodeService', () => {
  let service: GeocodeService;
  let provider: jest.Mocked<GeocodeProvider>;

  const result = (over: Partial<GeocodeResult> = {}): GeocodeResult => ({
    label: 'Brno, Czechia',
    lat: 49.2,
    lng: 16.6,
    importance: 0.5,
    ...over,
  });

  beforeEach(async () => {
    provider = { search: jest.fn(), reverse: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodeService,
        { provide: GEOCODE_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = module.get<GeocodeService>(GeocodeService);
  });

  it('returns empty results for an empty query without calling the provider', async () => {
    const res = await service.search('   ');
    expect(provider.search).not.toHaveBeenCalled();
    expect(res.results).toEqual([]);
  });

  it('defaults limit to the configured max when omitted or non-positive', async () => {
    provider.search.mockResolvedValue([]);
    await service.search('Brno');
    expect(provider.search.mock.calls[0][1]).toBe(5);

    // Distinct query so the response cache doesn't collapse the two calls.
    await service.search('Praha', 0);
    expect(provider.search.mock.calls[1][1]).toBe(5);
  });

  it('caps limit at the configured maximum', async () => {
    provider.search.mockResolvedValue([]);
    await service.search('Brno', 100);
    expect(provider.search.mock.calls[0][1]).toBe(5);
  });

  it('sorts results by importance desc then label asc', async () => {
    provider.search.mockResolvedValue([
      result({ label: 'B town', importance: 0.3 }),
      result({ label: 'A town', importance: 0.3 }),
      result({ label: 'C town', importance: 0.9 }),
    ]);
    const { results } = await service.search('x');
    expect(results.map((r) => r.label)).toEqual(['C town', 'A town', 'B town']);
  });

  it('rounds importance to three decimal places', async () => {
    provider.search.mockResolvedValue([result({ importance: 0.123456 })]);
    const { results } = await service.search('x');
    expect(results[0].importance).toBe(0.123);
  });

  it('returns an empty list on provider failure and does not throw', async () => {
    provider.search.mockRejectedValue(new Error('upstream down'));
    const res = await service.search('Brno');
    expect(res.results).toEqual([]);
  });

  it('trims whitespace from the query before passing it to the provider', async () => {
    provider.search.mockResolvedValue([]);
    await service.search('  Brno  ');
    expect(provider.search.mock.calls[0][0]).toBe('Brno');
  });

  describe('reverse', () => {
    it('returns the place label the provider resolves', async () => {
      provider.reverse.mockResolvedValue({ label: 'Brno' });
      const res = await service.reverse(49.2, 16.6);
      expect(provider.reverse).toHaveBeenCalledWith(49.2, 16.6);
      expect(res).toEqual({ label: 'Brno' });
    });

    it('returns a null label when the provider cannot name the point', async () => {
      provider.reverse.mockResolvedValue(null);
      const res = await service.reverse(0, 0);
      expect(res).toEqual({ label: null });
    });

    it('returns a null label on provider failure and does not throw', async () => {
      provider.reverse.mockRejectedValue(new Error('upstream down'));
      const res = await service.reverse(49.2, 16.6);
      expect(res).toEqual({ label: null });
    });
  });

  describe('caching (#909)', () => {
    it('serves a repeated search from cache without re-calling the provider', async () => {
      provider.search.mockResolvedValue([result()]);
      const first = await service.search('Brno');
      const second = await service.search('Brno');
      expect(provider.search).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('keys the search cache case-insensitively and by limit', async () => {
      provider.search.mockResolvedValue([result()]);
      await service.search('Brno');
      await service.search('BRNO'); // same key (case-folded) → hit
      expect(provider.search).toHaveBeenCalledTimes(1);
      await service.search('Brno', 3); // different limit → miss
      expect(provider.search).toHaveBeenCalledTimes(2);
    });

    it('does not cache a search provider failure (retries next call)', async () => {
      provider.search.mockRejectedValueOnce(new Error('down'));
      provider.search.mockResolvedValueOnce([result()]);
      const first = await service.search('Brno');
      expect(first.results).toEqual([]);
      const second = await service.search('Brno');
      expect(provider.search).toHaveBeenCalledTimes(2);
      expect(second.results).toHaveLength(1);
    });

    it('serves a repeated reverse lookup from cache (coords rounded to ~11 m)', async () => {
      provider.reverse.mockResolvedValue({ label: 'Brno' });
      await service.reverse(49.20001, 16.60001);
      await service.reverse(49.20002, 16.60002); // same to 4 dp → hit
      expect(provider.reverse).toHaveBeenCalledTimes(1);
    });

    it('caches an unnamed (null) reverse result but not a reverse failure', async () => {
      // A provider-returned null (e.g. open sea) is a stable fact → cached.
      provider.reverse.mockResolvedValue(null);
      await service.reverse(0, 0);
      await service.reverse(0, 0);
      expect(provider.reverse).toHaveBeenCalledTimes(1);

      // A thrown error is transient → not cached, retried next call.
      provider.reverse.mockReset();
      provider.reverse.mockRejectedValueOnce(new Error('down'));
      provider.reverse.mockResolvedValueOnce({ label: 'Praha' });
      expect(await service.reverse(50, 14)).toEqual({ label: null });
      expect(await service.reverse(50, 14)).toEqual({ label: 'Praha' });
      expect(provider.reverse).toHaveBeenCalledTimes(2);
    });
  });
});
