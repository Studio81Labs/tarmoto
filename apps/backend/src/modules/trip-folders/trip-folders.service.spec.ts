/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripFoldersService } from './trip-folders.service.js';

describe('TripFoldersService', () => {
  let service: TripFoldersService;
  let folderRepo: Partial<jest.Mocked<Repository<TripFolder>>>;
  let updateBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  let queryMock: jest.Mock;

  const userId = '00000000-0000-0000-0000-000000000001';
  const otherUserId = '00000000-0000-0000-0000-000000000002';
  const folderId = '11111111-1111-1111-1111-111111111111';

  const baseFolder = (overrides: Partial<TripFolder> = {}): TripFolder =>
    ({
      id: folderId,
      user_id: userId,
      name: 'Summer 2026 Alps',
      color: '#22d3ee',
      position: 0,
      created_at: new Date('2026-04-20T10:00:00Z'),
      updated_at: new Date('2026-04-20T10:00:00Z'),
      ...overrides,
    }) as TripFolder;

  beforeEach(async () => {
    updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    folderRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(
        (data: Partial<TripFolder>): TripFolder =>
          ({
            id: folderId,
            created_at: new Date('2026-04-20T10:00:00Z'),
            updated_at: new Date('2026-04-20T10:00:00Z'),
            ...data,
          }) as TripFolder,
      ),
      save: jest
        .fn()
        .mockImplementation((entity: TripFolder) => Promise.resolve(entity)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockImplementation(() => ({
        ...updateBuilder,
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: -1 }),
      })),
    };

    queryMock = jest.fn().mockResolvedValue(undefined);
    const dataSource: Partial<DataSource> = {
      transaction: jest
        .fn()
        .mockImplementation((cb: (mgr: unknown) => Promise<unknown>) =>
          cb({
            query: queryMock,
            getRepository: () => folderRepo,
          }),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripFoldersService,
        { provide: getRepositoryToken(TripFolder), useValue: folderRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(TripFoldersService);
  });

  describe('list', () => {
    it("returns the caller's folders ordered by position", async () => {
      (folderRepo.find as jest.Mock).mockResolvedValueOnce([
        baseFolder({ position: 0 }),
        baseFolder({ id: 'b', position: 1, name: 'Weekend Beskydy' }),
      ]);

      const result = await service.list(userId);

      expect(folderRepo.find).toHaveBeenCalledWith({
        where: { user_id: userId },
        order: { position: 'ASC', created_at: 'ASC' },
      });
      expect(result.total).toBe(2);
      expect(result.items[0]!.name).toBe('Summer 2026 Alps');
      expect(result.items[1]!.name).toBe('Weekend Beskydy');
    });
  });

  describe('create', () => {
    it('appends new folders at the end (MAX(position)+1) under an advisory lock', async () => {
      (folderRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: 2 }),
      });
      (folderRepo.save as jest.Mock).mockImplementationOnce((entity) =>
        Promise.resolve({
          ...entity,
          id: folderId,
          created_at: new Date('2026-04-20T10:00:00Z'),
          updated_at: new Date('2026-04-20T10:00:00Z'),
        }),
      );

      const result = await service.create(userId, { name: 'Tatry weekend' });

      // Advisory lock keyed per-user — concurrent creates serialise on
      // the same hashtext bucket, eliminating duplicate positions.
      expect(queryMock).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`trip_folders:${userId}`],
      );
      expect(folderRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: userId,
          name: 'Tatry weekend',
          color: null,
          position: 3,
        }),
      );
      expect(result.position).toBe(3);
    });

    it('starts at position 0 when the user has no folders', async () => {
      (folderRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        // COALESCE(MAX(...), -1) so an empty table maps to position 0
        // — Number(null) was the previous bug that blew up to NaN.
        getRawOne: jest.fn().mockResolvedValue({ max: -1 }),
      });

      const result = await service.create(userId, {
        name: 'First',
        color: '#FFAA00',
      });

      expect(result.position).toBe(0);
      // Hex colour is normalised to lower-case so downstream consumers
      // (CSS, hex equality) don't have to case-fold per call site.
      expect(folderRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ color: '#ffaa00' }),
      );
    });

    it('trims whitespace from the folder name', async () => {
      (folderRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: -1 }),
      });

      await service.create(userId, { name: '  Spring  ' });

      expect(folderRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Spring' }),
      );
    });
  });

  describe('update', () => {
    it('renames and recolours the folder when the caller owns it', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(baseFolder());
      (folderRepo.save as jest.Mock).mockImplementationOnce((entity) =>
        Promise.resolve({
          ...entity,
          updated_at: new Date('2026-04-21T11:00:00Z'),
        }),
      );

      const result = await service.update(userId, folderId, {
        name: 'Spring Loops',
        color: null,
      });

      expect(result.name).toBe('Spring Loops');
      expect(result.color).toBeNull();
      // Reorder must NOT have run when only name/colour changed.
      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('takes the per-user advisory lock to serialise vs concurrent remove/create', async () => {
      // Bugbot finding: without the per-user advisory lock, two
      // concurrent ops on different folders of the same user (e.g.
      // `update` of folder A while `remove` of folder C) could each
      // hold a `pessimistic_write` row lock that the other's
      // position-range UPDATE needed, deadlocking on PG.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(baseFolder());

      await service.update(userId, folderId, { name: 'Spring' });

      expect(queryMock).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`trip_folders:${userId}`],
      );
    });

    it('404s when the folder belongs to a different user (no info leak)', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.update(otherUserId, folderId, { name: 'Hijack' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('moves a folder up: shifts neighbours [to..from-1] by +1', async () => {
      // Move from position 3 to position 1. Two folders at 1 and 2 must
      // both shift up by one to make room — without the shift their
      // positions would collide with the moved row.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 3 }),
      );
      (folderRepo.count as jest.Mock).mockResolvedValueOnce(4);

      await service.update(userId, folderId, { position: 1 });

      expect(updateBuilder.update).toHaveBeenCalled();
      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ position: expect.any(Function) }),
      );
      // The moved folder is excluded from the bulk shift so it doesn't
      // get bumped twice (once via the shift, once via the explicit
      // save below).
      expect(updateBuilder.andWhere).toHaveBeenCalledWith('id <> :movingId', {
        movingId: folderId,
      });
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'position >= :to AND position < :from',
        { to: 1, from: 3 },
      );
    });

    it('moves a folder down: shifts neighbours [from+1..to] by -1', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 0 }),
      );
      (folderRepo.count as jest.Mock).mockResolvedValueOnce(4);

      await service.update(userId, folderId, { position: 2 });

      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'position > :from AND position <= :to',
        { from: 0, to: 2 },
      );
    });

    it('skips reorder work when the requested position equals current', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 5 }),
      );
      (folderRepo.count as jest.Mock).mockResolvedValueOnce(6);

      await service.update(userId, folderId, { position: 5, name: 'Same' });

      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('clamps an out-of-range position to count-1 instead of stamping a non-dense value', async () => {
      // Bugbot finding: `@Min(0)` only validates the lower bound
      // (`@Max` can't see the per-user count at DTO time), so a request
      // like `{position: 999}` against a 3-folder library used to write
      // 999 verbatim and break the dense-ordering invariant for all
      // subsequent reorders/deletes. The service now clamps to
      // count-1, which keeps the column 0..N-1.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 0 }),
      );
      (folderRepo.count as jest.Mock).mockResolvedValueOnce(3);
      let savedFolder: TripFolder | undefined;
      (folderRepo.save as jest.Mock).mockImplementationOnce(
        (entity: TripFolder) => {
          savedFolder = entity;
          return Promise.resolve(entity);
        },
      );

      await service.update(userId, folderId, { position: 999 });

      expect(savedFolder?.position).toBe(2);
      // Shift target must use the clamped value so the SQL range
      // matches what the row eventually lands on.
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'position > :from AND position <= :to',
        { from: 0, to: 2 },
      );
    });
  });

  describe('remove', () => {
    it('takes the per-user advisory lock to serialise vs concurrent update/create', async () => {
      // Same Bugbot rationale as the update test — `remove` issues a
      // bulk position UPDATE that overlaps the position range a
      // sibling `update` may be touching for a different folder of
      // the same user, so both sides must funnel through the
      // per-user advisory lock to avoid the deadlock diamond.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(baseFolder());
      (folderRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 1 });

      await service.remove(userId, folderId);

      expect(queryMock).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`trip_folders:${userId}`],
      );
    });

    it('takes a pessimistic_write lock on the row before deleting', async () => {
      // Bugbot finding: without the lock, two concurrent deletes can
      // both pass `findOne` and the second runs the position-shift
      // against the post-delete state, double-decrementing every row
      // above. The lock serialises sibling deletes against the same
      // folder so the second caller blocks → re-reads → sees no row.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(baseFolder());
      (folderRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 1 });

      await service.remove(userId, folderId);

      expect(folderRepo.findOne).toHaveBeenCalledWith({
        where: { id: folderId, user_id: userId },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('deletes the folder for its owner and relies on FK SET NULL for trips', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(baseFolder());
      (folderRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 1 });

      await expect(service.remove(userId, folderId)).resolves.toBeUndefined();

      // The FK on `trips.folder_id` is `ON DELETE SET NULL`, so we must
      // NOT issue a separate update against trips here — that would
      // duplicate the work the database already does atomically with
      // the delete.
      expect(folderRepo.delete).toHaveBeenCalledWith({
        id: folderId,
        user_id: userId,
      });
    });

    it('404s when the folder is not owned by the caller', async () => {
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.remove(otherUserId, folderId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(folderRepo.delete).not.toHaveBeenCalled();
    });

    it('skips the position shift and 404s when the row vanished between findOne and delete', async () => {
      // Defence in depth: even with the pessimistic lock above, if
      // some external tool hard-deletes the row outside this txn the
      // DELETE will report `affected: 0`. We must NOT run the shift
      // against a state we no longer own — the column would
      // double-shift if a sibling delete won the race.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 1 }),
      );
      (folderRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 0 });

      await expect(service.remove(userId, folderId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('shifts every folder above the deleted one down by 1 to keep positions dense', async () => {
      // Bugbot finding: deleting position 1 from [0,1,2,3] used to
      // leave [0,2,3] and the gap accumulated across deletes, which
      // poisoned the math in `shiftPositions` for subsequent reorders.
      // The new contract: delete + shift run in the same transaction.
      (folderRepo.findOne as jest.Mock).mockResolvedValueOnce(
        baseFolder({ position: 1 }),
      );
      (folderRepo.delete as jest.Mock).mockResolvedValueOnce({ affected: 1 });

      await service.remove(userId, folderId);

      // The bulk shift only touches rows STRICTLY above the deleted
      // position — rows at 0 stay put. Asserting via `andWhere` (shared
      // across calls through the spread) plus the `execute` side-effect
      // — the per-call `where` mock is recreated by the
      // createQueryBuilder factory so we can't track it from here.
      expect(updateBuilder.andWhere).toHaveBeenCalledWith('position > :from', {
        from: 1,
      });
      expect(updateBuilder.execute).toHaveBeenCalled();
    });
  });
});
