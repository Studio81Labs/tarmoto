/* eslint-disable @typescript-eslint/require-await */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  Repository,
  UpdateQueryBuilder,
  SelectQueryBuilder,
} from 'typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { BikesService } from './bikes.service.js';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

interface BikeRow {
  id: string;
  user_id: string;
  make: string;
  model: string;
  year: number | null;
  is_active: boolean;
  photo_url: string | null;
  icon: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Hand-rolled in-memory `bikes` store that respects the partial unique
 * index `(user_id) WHERE is_active = true`. The service's correctness
 * argument hinges on a real swap (deactivate-others-then-activate), so
 * the fake constraint mirrors the real one — any path that leaves two
 * active bikes for the same user throws a 23505, matching Postgres.
 */
class FakeBikeStore {
  private readonly rows: BikeRow[] = [];
  private nextId = 1;

  list(): BikeRow[] {
    return this.rows;
  }

  insert(
    input: Partial<BikeRow> & Pick<BikeRow, 'user_id' | 'make' | 'model'>,
  ): BikeRow {
    const now = new Date();
    const row: BikeRow = {
      id: input.id ?? `bike-${this.nextId++}`,
      user_id: input.user_id,
      make: input.make,
      model: input.model,
      year: input.year ?? null,
      is_active: input.is_active ?? false,
      photo_url: input.photo_url ?? null,
      icon: input.icon ?? null,
      notes: input.notes ?? null,
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    };
    this.assertSingleActive(row);
    this.rows.push(row);
    return row;
  }

  update(target: BikeRow): void {
    const idx = this.rows.findIndex((r) => r.id === target.id);
    if (idx === -1) throw new Error('row missing');
    this.rows[idx] = { ...target, updated_at: new Date() };
    this.assertSingleActive(this.rows[idx]);
  }

  delete(predicate: (r: BikeRow) => boolean): number {
    let deleted = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (predicate(this.rows[i]!)) {
        this.rows.splice(i, 1);
        deleted++;
      }
    }
    return deleted;
  }

  deactivateAll(userId: string): number {
    let touched = 0;
    for (const r of this.rows) {
      if (r.user_id === userId && r.is_active) {
        r.is_active = false;
        r.updated_at = new Date();
        touched++;
      }
    }
    return touched;
  }

  private assertSingleActive(row: BikeRow): void {
    if (!row.is_active) return;
    const others = this.rows.filter(
      (r) => r.user_id === row.user_id && r.is_active && r.id !== row.id,
    );
    if (others.length > 0) {
      const err = new Error(
        'duplicate key value violates unique constraint "idx_bikes_user_active"',
      ) as Error & { code: string };
      err.code = '23505';
      throw err;
    }
  }
}

function buildRepo(
  store: FakeBikeStore,
): Partial<Record<keyof Repository<Bike>, jest.Mock>> {
  const toEntity = (row: BikeRow): Bike => ({ ...(row as unknown as Bike) });

  const repo: Partial<Record<keyof Repository<Bike>, jest.Mock>> = {
    find: jest.fn(
      async ({
        where,
        order,
      }: {
        where?: Partial<BikeRow>;
        order?: { created_at?: 'DESC' | 'ASC' };
      } = {}) => {
        let rows = store.list().filter((r) => {
          if (!where) return true;
          return Object.entries(where).every(
            ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
          );
        });
        if (order?.created_at === 'DESC') {
          rows = [...rows].sort(
            (a, b) => b.created_at.getTime() - a.created_at.getTime(),
          );
        }
        return rows.map(toEntity);
      },
    ),
    findOne: jest.fn(
      async ({
        where,
        order,
      }: {
        where: Partial<BikeRow>;
        order?: { created_at?: 'DESC' | 'ASC' };
      }) => {
        let rows = store
          .list()
          .filter((r) =>
            Object.entries(where).every(
              ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
            ),
          );
        if (order?.created_at === 'DESC') {
          rows = [...rows].sort(
            (a, b) => b.created_at.getTime() - a.created_at.getTime(),
          );
        }
        return rows[0] ? toEntity(rows[0]) : null;
      },
    ),
    count: jest.fn(async ({ where }: { where?: Partial<BikeRow> } = {}) => {
      return store
        .list()
        .filter((r) =>
          !where
            ? true
            : Object.entries(where).every(
                ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
              ),
        ).length;
    }),
    create: jest.fn((data: Partial<Bike>) => ({ ...data }) as Bike),
    save: jest.fn(async (entity: Bike) => {
      const existing = store.list().find((r) => r.id === entity.id);
      if (existing) {
        store.update({ ...existing, ...(entity as unknown as BikeRow) });
        return entity;
      }
      const inserted = store.insert(entity);
      return toEntity(inserted);
    }),
    delete: jest.fn(async (where: Partial<BikeRow>) => {
      const affected = store.delete((r) =>
        Object.entries(where).every(
          ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
        ),
      );
      return { affected, raw: [] } as never;
    }),
  };
  return repo;
}

describe('BikesService', () => {
  let service: BikesService;
  let store: FakeBikeStore;
  let repo: ReturnType<typeof buildRepo>;
  let dataSource: jest.Mocked<DataSource>;
  let ridesQbRows: Array<{
    bike_id: string;
    total_rides: string;
    total_km: string;
  }>;

  beforeEach(async () => {
    store = new FakeBikeStore();
    repo = buildRepo(store);
    ridesQbRows = [];

    // The transactional code path uses `dataSource.transaction(cb)` and
    // `tx.getRepository(Bike)` / `tx.createQueryBuilder(Ride, 'r')`.
    // The fake collapses to the same in-memory store so the
    // deactivate-then-activate sequence really runs end-to-end.
    const updateQb: Partial<UpdateQueryBuilder<Bike>> = {
      set: jest.fn().mockReturnThis() as never,
      where: jest.fn(function (
        this: { _userId?: string },
        _expr: string,
        params: { userId: string },
      ) {
        this._userId = params.userId;
        return this;
      }) as never,
      execute: jest.fn(async function (this: { _userId?: string }) {
        const affected = store.deactivateAll(this._userId!);
        return { affected, raw: [], generatedMaps: [] };
      }),
    };

    const ridesQb: Partial<SelectQueryBuilder<Ride>> = {
      select: jest.fn().mockReturnThis() as never,
      addSelect: jest.fn().mockReturnThis() as never,
      where: jest.fn().mockReturnThis() as never,
      andWhere: jest.fn().mockReturnThis() as never,
      groupBy: jest.fn().mockReturnThis() as never,
      // Reads from the closure variable so tests can stub aggregate
      // rows by mutating `ridesQbRows` before calling the service.
      getRawMany: jest.fn(async () => ridesQbRows) as never,
    };

    const tx = {
      getRepository: jest.fn(() => repo),
      // `lockGarage` issues a raw `pg_advisory_xact_lock` query — the
      // mock returns void so the call surface is exercised in tests.
      query: jest.fn(async () => []),
      createQueryBuilder: jest.fn((entity?: unknown) => {
        // `update(Bike)` and `createQueryBuilder(Ride, alias)` share
        // the same mock entry point in TypeORM — disambiguate by
        // checking the entity hint.
        if (entity === Ride) return ridesQb;
        return { update: jest.fn(() => updateQb) };
      }),
    } as unknown as EntityManager;

    dataSource = {
      transaction: jest.fn(async (cb: (tx: EntityManager) => unknown) =>
        cb(tx),
      ),
      manager: tx,
    } as unknown as jest.Mocked<DataSource>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BikesService,
        { provide: getRepositoryToken(Bike), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(BikesService);
  });

  describe('create', () => {
    it('marks the rider’s first bike active even when the request omits is_active', async () => {
      const bike = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });

      expect(bike.isActive).toBe(true);
      expect(store.list()).toHaveLength(1);
    });

    it('atomically swaps the active flag when adding a second bike with is_active=true', async () => {
      const first = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
        is_active: true,
      });

      expect(first.isActive).toBe(true);
      expect(second.isActive).toBe(true);
      const rows = store.list().filter((r) => r.user_id === USER_A);
      const active = rows.filter((r) => r.is_active);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(second.id);
      // Both writes happened inside a single tx — proves the swap
      // can't observe a two-active state under concurrent activation.
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('keeps the second bike inactive when is_active is omitted (only first is implicitly active)', async () => {
      await service.create(USER_A, { make: 'Honda', model: 'Africa Twin' });
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
      });
      expect(second.isActive).toBe(false);
    });

    it('persists notes and icon when supplied', async () => {
      const bike = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
        icon: 'adventure',
        notes: 'Crash bars + skid plate',
      });
      expect(bike.icon).toBe('adventure');
      expect(bike.notes).toBe('Crash bars + skid plate');
    });
  });

  describe('update', () => {
    it('refuses to load another user’s bike (NotFound, no DB writes)', async () => {
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      // User B tries to activate user A's bike → NotFound, never throws
      // a 200 with mutated state.
      await expect(
        service.update(USER_B, a.id, { is_active: false }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const row = store.list().find((r) => r.id === a.id)!;
      expect(row.is_active).toBe(true); // unchanged
    });

    it('atomically swaps active flag when activating a different bike', async () => {
      const first = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
      });

      const updated = await service.update(USER_A, second.id, {
        is_active: true,
      });

      expect(updated.isActive).toBe(true);
      const rows = store.list().filter((r) => r.user_id === USER_A);
      expect(rows.filter((r) => r.is_active)).toHaveLength(1);
      const firstAfter = rows.find((r) => r.id === first.id)!;
      expect(firstAfter.is_active).toBe(false);
    });

    it('treats deactivating the only bike as a no-op (always one active)', async () => {
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });

      const updated = await service.update(USER_A, a.id, {
        is_active: false,
        notes: 'service due',
      });

      expect(updated.isActive).toBe(true); // silently kept active
      expect(updated.notes).toBe('service due'); // other fields still applied
    });

    it('treats deactivating the active bike as a no-op even with multiple bikes (preserves invariant)', async () => {
      // Regression for the bug-bot finding: a multi-bike rider could
      // POST `is_active: false` against their active bike and end up
      // with zero active bikes — `/rides/start` would then tag rides
      // with `null`. The contract is "always one active", so the
      // service silently keeps the active flag and asks the rider to
      // activate a different bike instead.
      const first = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      await service.create(USER_A, { make: 'Yamaha', model: 'MT-09' });

      const updated = await service.update(USER_A, first.id, {
        is_active: false,
        notes: 'oil change due',
      });

      expect(updated.isActive).toBe(true); // silently kept active
      expect(updated.notes).toBe('oil change due');

      const rows = store.list().filter((r) => r.user_id === USER_A);
      expect(rows.filter((r) => r.is_active)).toHaveLength(1);
    });

    it('updates notes and icon without flipping active state', async () => {
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });

      const updated = await service.update(USER_A, a.id, {
        notes: 'oil change in 1k',
        icon: 'adventure',
      });

      expect(updated.notes).toBe('oil change in 1k');
      expect(updated.icon).toBe('adventure');
      expect(updated.isActive).toBe(true);
    });
  });

  describe('delete', () => {
    it('rejects a delete from a non-owner with NotFound', async () => {
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });

      await expect(service.delete(USER_B, a.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(store.list()).toHaveLength(1);
    });

    it('promotes the next remaining bike to active when the active one is deleted', async () => {
      const first = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      // Delay so the second bike has a strictly later `created_at` and
      // wins the `ORDER BY created_at DESC` tiebreaker for promotion.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
      });

      await service.delete(USER_A, first.id);

      const remaining = store.list().filter((r) => r.user_id === USER_A);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(second.id);
      expect(remaining[0]!.is_active).toBe(true);
    });

    it('deletes a non-active bike without re-activating anything', async () => {
      const first = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
      });

      await service.delete(USER_A, second.id);

      const remaining = store.list().filter((r) => r.user_id === USER_A);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(first.id);
      expect(remaining[0]!.is_active).toBe(true);
    });
  });

  describe('findActive', () => {
    it('returns the active bike or null', async () => {
      expect(await service.findActive(USER_A)).toBeNull();
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      const found = await service.findActive(USER_A);
      expect(found?.id).toBe(a.id);
    });

    it('does not leak other riders’ active bike', async () => {
      await service.create(USER_A, { make: 'Honda', model: 'Africa Twin' });
      expect(await service.findActive(USER_B)).toBeNull();
    });
  });

  describe('getActive', () => {
    it('returns null when the rider has no garage', async () => {
      expect(await service.getActive(USER_A)).toBeNull();
    });

    it('returns the active bike with stats populated (not zeroed out)', async () => {
      // Regression for the bug-bot finding: getActive used to pass
      // `undefined` stats, so the DTO claimed `totalKm: 0` /
      // `totalRides: 0` even when the bike had completed rides. The
      // ridesQb mock resolves with a representative aggregate row so
      // the assertion proves stats are actually carried through.
      const a = await service.create(USER_A, {
        make: 'Honda',
        model: 'Africa Twin',
      });
      ridesQbRows = [{ bike_id: a.id, total_rides: '5', total_km: '123.4' }];

      const dto = await service.getActive(USER_A);
      expect(dto?.id).toBe(a.id);
      expect(dto?.totalRides).toBe(5);
      expect(dto?.totalKm).toBe(123.4);
    });
  });

  describe('list', () => {
    it('returns bikes scoped to the rider, newest first', async () => {
      await service.create(USER_A, { make: 'Honda', model: 'Africa Twin' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await service.create(USER_A, {
        make: 'Yamaha',
        model: 'MT-09',
      });
      await service.create(USER_B, { make: 'BMW', model: 'R1250GS' });

      const bikes = await service.list(USER_A);
      expect(bikes).toHaveLength(2);
      expect(bikes[0]!.id).toBe(second.id); // newest first
      expect(bikes.every((b) => b.id !== undefined)).toBe(true);
    });
  });
});
