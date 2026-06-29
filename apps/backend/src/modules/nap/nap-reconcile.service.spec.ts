import { DataSource, Repository } from 'typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { NapReconcileService } from './nap-reconcile.service.js';
import type { NapConfig } from './nap.config.js';
import type { NapSituation } from './types/nap-situation.types.js';

const CONFIG: NapConfig = {
  snapshotUrl: 'https://ndic.example/pull',
  username: '',
  password: '',
  clientCertPath: '',
  clientKeyPath: '',
  source: 'official',
  countryCode: 'CZ',
  pollEnabled: true,
};

function situation(over: Partial<NapSituation> = {}): NapSituation {
  return {
    externalId: 'ndic-1',
    title: 'Road closure on D1',
    reason: 'closure',
    severity: 'full',
    validityStatus: 'active',
    startsAt: new Date('2026-06-29T08:00:00Z'),
    endsAt: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.25],
      ],
    },
    needsLocationDecoding: false,
    rawLocationRef: null,
    ...over,
  };
}

describe('NapReconcileService', () => {
  let updateExecute: jest.Mock;
  let updateWhere: jest.Mock;
  let updateAndWhere: jest.Mock;
  let txRepo: {
    findOne: jest.Mock;
    merge: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: NapReconcileService;

  beforeEach(() => {
    updateExecute = jest.fn().mockResolvedValue({ affected: 0 });
    updateWhere = jest.fn().mockReturnThis();
    updateAndWhere = jest.fn().mockReturnThis();
    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: updateWhere,
      andWhere: updateAndWhere,
      execute: updateExecute,
    };
    txRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      merge: jest.fn(
        (target: Record<string, unknown>, src: Record<string, unknown>) => {
          Object.assign(target, src);
        },
      ),
      save: jest.fn((r: unknown) => Promise.resolve(r)),
      create: jest.fn((d: unknown) => d),
      createQueryBuilder: jest.fn(() => updateQb),
    };
    const manager = { getRepository: () => txRepo };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<number>) =>
        cb(manager),
      ),
    } as unknown as Pick<DataSource, 'transaction'>;

    service = new NapReconcileService(
      {} as Repository<RoadClosure>,
      dataSource as DataSource,
      CONFIG,
    );
  });

  it('inserts a new situation with feed bookkeeping', async () => {
    const result = await service.reconcile([situation()]);

    expect(txRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'official',
        external_id: 'ndic-1',
        country_code: 'CZ',
        is_active: true,
        created_by: null,
        reason: 'closure',
        severity: 'full',
      }),
    );
    const createCalls = txRepo.create.mock.calls as Record<string, unknown>[][];
    const created = createCalls[0][0];
    expect(created.first_seen_at).toBeInstanceOf(Date);
    expect(created.last_seen_at).toEqual(created.first_seen_at);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('updates an existing row by (source, external_id) without re-inserting', async () => {
    txRepo.findOne.mockResolvedValueOnce({ id: 'x', source: 'official' });
    const result = await service.reconcile([situation()]);

    expect(txRepo.merge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'x' }),
      expect.objectContaining({ is_active: true, reason: 'closure' }),
    );
    expect(txRepo.create).not.toHaveBeenCalled();
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('stores an undecoded (null-geometry) row flagged for decoding', async () => {
    const result = await service.reconcile([
      situation({
        externalId: 'ndic-tmc',
        geometry: null,
        needsLocationDecoding: true,
        rawLocationRef: { alertC: 'code' },
      }),
    ]);

    expect(txRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        geom: null,
        needs_location_decoding: true,
        raw_location_ref: { alertC: 'code' },
      }),
    );
    expect(result.needsDecoding).toBe(1);
  });

  it('deactivates feed rows absent from the snapshot and reports the count', async () => {
    updateExecute.mockResolvedValueOnce({ affected: 3 });
    const result = await service.reconcile([situation()]);

    // The deactivate pass scopes to this source + is_active + the
    // absent/expired predicate.
    expect(updateWhere).toHaveBeenCalledWith('source = :source', {
      source: 'official',
    });
    expect(updateAndWhere).toHaveBeenCalledWith('is_active = true');
    expect(result.deactivated).toBe(3);
  });

  it('falls back to the batch time when a situation has no start time', async () => {
    await service.reconcile([situation({ startsAt: null })]);
    const createCalls = txRepo.create.mock.calls as Record<string, unknown>[][];
    expect(createCalls[0][0].starts_at).toBeInstanceOf(Date);
  });
});
