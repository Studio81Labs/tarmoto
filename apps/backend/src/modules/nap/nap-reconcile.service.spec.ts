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
    find: jest.Mock;
    upsert: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  // The single row passed to the (mocked) bulk upsert.
  const upsertedRow = (): Record<string, unknown> => {
    const calls = txRepo.upsert.mock.calls as Record<string, unknown>[][][];
    return calls[0]![0]![0]!;
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
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(() => updateQb),
    };
    const manager = { getRepository: () => txRepo };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
        cb(manager),
      ),
    } as unknown as Pick<DataSource, 'transaction'>;

    service = new NapReconcileService(
      {} as Repository<RoadClosure>,
      dataSource as DataSource,
      CONFIG,
    );
  });

  it('bulk-upserts a new situation with feed bookkeeping', async () => {
    const result = await service.reconcile([situation()]);

    // One bulk upsert keyed on the (source, external_id) unique index —
    // not a findOne+save per record.
    expect(txRepo.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = txRepo.upsert.mock.calls[0] as [unknown, unknown];
    expect(upsertArgs[1]).toEqual(
      expect.objectContaining({
        conflictPaths: ['source', 'external_id'],
      }),
    );
    const row = upsertedRow();
    expect(row).toEqual(
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
    expect(row.first_seen_at).toBeInstanceOf(Date);
    expect(row.last_seen_at).toEqual(row.first_seen_at);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('preloads existing rows, counts them as updates, and preserves first_seen_at', async () => {
    const originalFirstSeen = new Date('2026-06-01T00:00:00Z');
    txRepo.find.mockResolvedValueOnce([
      { external_id: 'ndic-1', first_seen_at: originalFirstSeen },
    ]);
    const result = await service.reconcile([situation()]);

    expect(txRepo.find).toHaveBeenCalledTimes(1);
    // Upserted row keeps the original first_seen_at rather than resetting
    // it to the batch time.
    expect(upsertedRow().first_seen_at).toEqual(originalFirstSeen);
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

    expect(upsertedRow()).toEqual(
      expect.objectContaining({
        geom: null,
        needs_location_decoding: true,
        raw_location_ref: { alertC: 'code' },
      }),
    );
    expect(result.needsDecoding).toBe(1);
  });

  it('preserves an already-decoded geometry when the feed still lacks coords', async () => {
    const decoded = {
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.25],
      ],
    };
    // The stored row was decoded out-of-band: it has geometry, is no
    // longer flagged, and carries the SAME raw location reference.
    txRepo.find.mockResolvedValueOnce([
      {
        external_id: 'ndic-tmc',
        first_seen_at: new Date('2026-06-01T00:00:00Z'),
        geom: decoded,
        needs_location_decoding: false,
        raw_location_ref: { alertC: 'code' },
      },
    ]);
    const result = await service.reconcile([
      situation({
        externalId: 'ndic-tmc',
        geometry: null,
        needsLocationDecoding: true,
        rawLocationRef: { alertC: 'code' },
      }),
    ]);

    const row = upsertedRow();
    expect(row.geom).toEqual(decoded); // not overwritten back to null
    expect(row.needs_location_decoding).toBe(false);
    expect(result.needsDecoding).toBe(0);
  });

  it('drops a stale decoded geometry when the raw location reference changes', async () => {
    txRepo.find.mockResolvedValueOnce([
      {
        external_id: 'ndic-tmc',
        first_seen_at: new Date('2026-06-01T00:00:00Z'),
        geom: {
          type: 'LineString',
          coordinates: [
            [16.6, 49.2],
            [16.7, 49.25],
          ],
        },
        needs_location_decoding: false,
        raw_location_ref: { alertC: 'OLD' },
      },
    ]);
    const result = await service.reconcile([
      situation({
        externalId: 'ndic-tmc',
        geometry: null,
        needsLocationDecoding: true,
        rawLocationRef: { alertC: 'NEW' }, // location moved
      }),
    ]);

    const row = upsertedRow();
    expect(row.geom).toBeNull(); // stale geometry not preserved
    expect(row.needs_location_decoding).toBe(true);
    expect(result.needsDecoding).toBe(1);
  });

  it('chunks a large snapshot into multiple upserts (param-limit safety)', async () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      situation({ externalId: `ndic-${i}` }),
    );
    await service.reconcile(many);
    // 600 rows / 500-per-chunk = 2 upsert statements.
    expect(txRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it('writes is_active=false for a suspended DATEX situation', async () => {
    await service.reconcile([situation({ validityStatus: 'suspended' })]);
    expect(upsertedRow().is_active).toBe(false);
  });

  it('writes is_active=false for a planned situation with a past/reached start', async () => {
    await service.reconcile([
      situation({
        validityStatus: 'planned',
        startsAt: new Date('2020-01-01T00:00:00Z'), // already reached
      }),
    ]);
    expect(upsertedRow().is_active).toBe(false);
  });

  it('keeps a planned situation with a FUTURE start active (so it can be previewed)', async () => {
    await service.reconcile([
      situation({
        validityStatus: 'planned',
        startsAt: new Date('2099-01-01T00:00:00Z'), // future window
      }),
    ]);
    // is_active stays true; the active_on time-window hides it now but
    // surfaces it for a future-date preview.
    expect(upsertedRow().is_active).toBe(true);
  });

  it('keeps is_active=true for active / time-window-governed situations', async () => {
    await service.reconcile([
      situation({ validityStatus: 'definedByValidityTimeSpecification' }),
    ]);
    expect(upsertedRow().is_active).toBe(true);
  });

  it('preserves the existing starts_at on update when the feed omits a start time', async () => {
    const originalStart = new Date('2026-05-01T00:00:00Z');
    txRepo.find.mockResolvedValueOnce([
      {
        external_id: 'ndic-1',
        first_seen_at: new Date('2026-05-01T00:00:00Z'),
        starts_at: originalStart,
      },
    ]);
    await service.reconcile([situation({ startsAt: null })]);
    // Not pushed forward to the batch time.
    expect(upsertedRow().starts_at).toEqual(originalStart);
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
    expect(upsertedRow().starts_at).toBeInstanceOf(Date);
  });
});
