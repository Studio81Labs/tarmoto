import { MapillaryService } from './mapillary.service.js';
import type { StreetImageryProvider } from './mapillary-provider.interface.js';

function makeService(
  provider: Partial<StreetImageryProvider>,
): MapillaryService {
  return new MapillaryService(provider as StreetImageryProvider);
}

const NO_IMAGERY = {
  imageId: null,
  capturedAt: null,
  attribution: null,
  link: null,
};

describe('MapillaryService', () => {
  describe('segmentImagery', () => {
    it('returns and caches a found image, calling the provider once', async () => {
      const nearestImage = jest.fn().mockResolvedValue({
        imageId: 'mly-1',
        capturedAt: '2024-09-15',
        attribution: '© rider · Mapillary (CC BY-SA)',
        link: 'https://www.mapillary.com/app/?pKey=mly-1',
      });
      const service = makeService({ nearestImage });

      const first = await service.segmentImagery(46.5, 10.4, 90);
      const second = await service.segmentImagery(46.5, 10.4, 90);

      expect(first).toEqual({
        imageId: 'mly-1',
        capturedAt: '2024-09-15',
        attribution: '© rider · Mapillary (CC BY-SA)',
        link: 'https://www.mapillary.com/app/?pKey=mly-1',
      });
      expect(second).toEqual(first);
      expect(nearestImage).toHaveBeenCalledTimes(1); // second served from cache
    });

    it('caches a "no coverage" result so it is not re-queried', async () => {
      const nearestImage = jest.fn().mockResolvedValue(null);
      const service = makeService({ nearestImage });

      const a = await service.segmentImagery(1, 2);
      const b = await service.segmentImagery(1, 2);

      expect(a).toEqual(NO_IMAGERY);
      expect(b).toEqual(a);
      expect(nearestImage).toHaveBeenCalledTimes(1);
    });

    it('degrades to no imagery on a provider error WITHOUT caching (transient)', async () => {
      const nearestImage = jest.fn().mockRejectedValue(new Error('boom'));
      const service = makeService({ nearestImage });

      const a = await service.segmentImagery(3, 4);
      await service.segmentImagery(3, 4);

      expect(a).toEqual(NO_IMAGERY);
      expect(nearestImage).toHaveBeenCalledTimes(2); // not cached → retried
    });
  });

  describe('thumbnail', () => {
    it('returns and caches the bytes, calling the provider once', async () => {
      const bytes = { contentType: 'image/jpeg', body: Buffer.from([1, 2, 3]) };
      const thumbnail = jest.fn().mockResolvedValue(bytes);
      const service = makeService({ thumbnail });

      const first = await service.thumbnail('mly-1');
      const second = await service.thumbnail('mly-1');

      expect(first).toBe(bytes);
      expect(second).toBe(bytes);
      expect(thumbnail).toHaveBeenCalledTimes(1); // second served from cache
    });

    it('returns null on a provider error WITHOUT caching (transient)', async () => {
      const thumbnail = jest.fn().mockRejectedValue(new Error('boom'));
      const service = makeService({ thumbnail });

      expect(await service.thumbnail('mly-1')).toBeNull();
      await service.thumbnail('mly-1');
      expect(thumbnail).toHaveBeenCalledTimes(2); // not cached → retried
    });
  });
});
