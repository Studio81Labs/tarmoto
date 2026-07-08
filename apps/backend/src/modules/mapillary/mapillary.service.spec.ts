import { MapillaryService } from './mapillary.service.js';
import type { StreetImageryProvider } from './mapillary-provider.interface.js';

function makeService(
  nearestImage: StreetImageryProvider['nearestImage'],
): MapillaryService {
  return new MapillaryService({ nearestImage });
}

const NO_IMAGERY = { imageUrl: null, capturedAt: null, attribution: null };

describe('MapillaryService', () => {
  it('returns and caches a found image, calling the provider once', async () => {
    const nearestImage = jest.fn().mockResolvedValue({
      imageUrl: 'https://img/1',
      capturedAt: '2024-09-15',
      attribution: '© rider · Mapillary (CC BY-SA)',
    });
    const service = makeService(nearestImage);

    const first = await service.segmentImagery(46.5, 10.4, 90);
    const second = await service.segmentImagery(46.5, 10.4, 90);

    expect(first).toEqual({
      imageUrl: 'https://img/1',
      capturedAt: '2024-09-15',
      attribution: '© rider · Mapillary (CC BY-SA)',
    });
    expect(second).toEqual(first);
    expect(nearestImage).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('caches a "no coverage" result so it is not re-queried', async () => {
    const nearestImage = jest.fn().mockResolvedValue(null);
    const service = makeService(nearestImage);

    const a = await service.segmentImagery(1, 2);
    const b = await service.segmentImagery(1, 2);

    expect(a).toEqual(NO_IMAGERY);
    expect(b).toEqual(a);
    expect(nearestImage).toHaveBeenCalledTimes(1);
  });

  it('degrades to no imagery on a provider error WITHOUT caching (transient)', async () => {
    const nearestImage = jest.fn().mockRejectedValue(new Error('boom'));
    const service = makeService(nearestImage);

    const a = await service.segmentImagery(3, 4);
    await service.segmentImagery(3, 4);

    expect(a).toEqual(NO_IMAGERY);
    // Not cached → the next call retries rather than pinning the failure.
    expect(nearestImage).toHaveBeenCalledTimes(2);
  });
});
