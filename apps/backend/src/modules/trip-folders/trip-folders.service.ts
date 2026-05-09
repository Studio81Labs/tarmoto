import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import {
  CreateTripFolderDto,
  TripFolderListResponseDto,
  TripFolderResponseDto,
  UpdateTripFolderDto,
} from './dto/trip-folder.dto.js';

/**
 * US-37 — backend persistence for the rider's trip folders.
 *
 * Folders are flat (no nesting), per-user, manually ordered. Cross-user
 * access yields a 404 (not 403) so the endpoint can't be used to
 * enumerate folder ids belonging to other riders.
 *
 * The companion previously stored these rows in `localStorage`; this
 * service replaces that with a real table so folders sync between
 * browsers and surface read-only on mobile.
 */
@Injectable()
export class TripFoldersService {
  constructor(
    @InjectRepository(TripFolder)
    private readonly folderRepo: Repository<TripFolder>,
    private readonly dataSource: DataSource,
  ) {}

  async list(userId: string): Promise<TripFolderListResponseDto> {
    const rows = await this.folderRepo.find({
      where: { user_id: userId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
    return { items: rows.map(toResponse), total: rows.length };
  }

  async create(
    userId: string,
    dto: CreateTripFolderDto,
  ): Promise<TripFolderResponseDto> {
    // New folders land at the end of the user's list. We compute
    // MAX(position)+1 inside a transaction with a row-level advisory
    // lock so concurrent creates don't both pick the same position
    // (PG's default READ COMMITTED would otherwise let two parallel
    // requests read the same MAX before either INSERT lands).
    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TripFolder);
      // Per-user advisory lock; uses the user's UUID hashed to a 32-bit
      // int so the lock space is bounded. Releases at txn end.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `trip_folders:${userId}`,
      ]);
      const maxRow = await repo
        .createQueryBuilder('f')
        .select('COALESCE(MAX(f.position), -1)', 'max')
        .where('f.user_id = :userId', { userId })
        .getRawOne<{ max: number | string }>();
      const nextPosition = Number(maxRow?.max ?? -1) + 1;
      const folder = repo.create({
        user_id: userId,
        name: dto.name.trim(),
        color: normaliseColor(dto.color),
        position: nextPosition,
      });
      return repo.save(folder);
    });
    return toResponse(saved);
  }

  async update(
    userId: string,
    folderId: string,
    dto: UpdateTripFolderDto,
  ): Promise<TripFolderResponseDto> {
    // Reorder lives in the same transaction as the field update so a
    // user toggling name AND position in one PATCH (the planner UI does
    // this on drop-and-rename combos) commits atomically. If the row
    // isn't visible to the caller we 404 — never 403 — so the endpoint
    // stays a non-channel for cross-user folder enumeration.
    const updated = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TripFolder);
      const folder = await repo.findOne({
        where: { id: folderId, user_id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!folder) throw new NotFoundException('Folder not found');

      if (dto.name !== undefined) folder.name = dto.name.trim();
      if (dto.color !== undefined) folder.color = normaliseColor(dto.color);

      if (dto.position !== undefined) {
        // The DTO only enforces `position >= 0` because the per-user
        // count isn't known at validation time. Clamp the upper bound
        // against the live row count so a request like `{position: 999}`
        // for a 3-folder library renumbers to "last" instead of stamping
        // an out-of-range value the dense-ordering math (in
        // `shiftPositions` and `remove`) can't recover from. The count
        // is read inside the same locked transaction so a concurrent
        // create/delete can't shift the maximum out from under us
        // between the count and the SET below.
        const count = await repo.count({ where: { user_id: userId } });
        const target = Math.min(
          Math.max(dto.position, 0),
          Math.max(0, count - 1),
        );
        if (target !== folder.position) {
          await this.shiftPositions(
            manager.getRepository(TripFolder),
            userId,
            folder.id,
            folder.position,
            target,
          );
          folder.position = target;
        }
      }

      return repo.save(folder);
    });
    return toResponse(updated);
  }

  async remove(userId: string, folderId: string): Promise<void> {
    // Three things have to happen atomically:
    //  1. Delete the row. The FK on `trips.folder_id` is `ON DELETE SET
    //     NULL`, so child trips become unfiled in the same statement.
    //  2. Decrement the position of every folder that sat AFTER the
    //     deleted one. Skipping this leaves a gap (e.g. delete pos 1
    //     from [0,1,2,3] → [0,2,3]) that accumulates over repeated
    //     deletes; the reorder UPDATE math in `shiftPositions` assumes
    //     dense 0..N-1 positions and produces drift in the gappy state.
    //  3. Two concurrent deletes of the same folder must NOT both run
    //     the position shift. Without a per-row lock, both txns could
    //     pass the `findOne` and one of them would `affected: 0` on
    //     the DELETE — but still execute the shift, double-decrementing
    //     every position above. We take a `pessimistic_write` lock on
    //     the target row so the second caller blocks until the first
    //     commits, then re-reads and finds the row gone.
    //
    // Cross-user delete: 404 instead of 403, mirroring `update`.
    const deleted = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TripFolder);
      const folder = await repo.findOne({
        where: { id: folderId, user_id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!folder) return false;
      const result = await repo.delete({ id: folderId, user_id: userId });
      // The pessimistic lock above already serialises concurrent
      // deletes, so by the time we reach this point a sibling delete
      // cannot still be in flight against the same row. If `affected`
      // is somehow 0 (e.g. the row was hard-deleted by a tool outside
      // this txn between the locked read and the DELETE), treat the
      // call as a no-op rather than running the shift over a state
      // we no longer own.
      if (result.affected === 0) return false;
      // Pull every folder above the deleted one down by one so the
      // column stays dense within this user. Ordering doesn't matter —
      // the rows being shifted have unique positions to start with and
      // each lands at a unique pre-existing position vacated by its
      // predecessor's shift, so there's no transient unique-index
      // collision (and we don't have a unique index on (user_id,
      // position) anyway).
      await repo
        .createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('user_id = :userId', { userId })
        .andWhere('position > :from', { from: folder.position })
        .execute();
      return true;
    });
    if (!deleted) {
      throw new NotFoundException('Folder not found');
    }
  }

  /**
   * Renumber neighbours so positions stay dense (0..N-1) within the
   * caller's folder list when an existing folder moves between
   * `from` and `to`.
   *
   * Two SQL UPDATE shapes cover the two move directions:
   *  - Move up (smaller index): rows in [to, from-1] shift +1.
   *  - Move down (larger index): rows in [from+1, to] shift -1.
   *
   * The SET expression skips the moved folder by id so we don't double-
   * shift it (the caller persists its new `position` separately).
   */
  private async shiftPositions(
    repo: Repository<TripFolder>,
    userId: string,
    movingId: string,
    from: number,
    to: number,
  ): Promise<void> {
    if (from === to) return;
    if (to < from) {
      await repo
        .createQueryBuilder()
        .update()
        .set({ position: () => 'position + 1' })
        .where('user_id = :userId', { userId })
        .andWhere('id <> :movingId', { movingId })
        .andWhere('position >= :to AND position < :from', { to, from })
        .execute();
    } else {
      await repo
        .createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('user_id = :userId', { userId })
        .andWhere('id <> :movingId', { movingId })
        .andWhere('position > :from AND position <= :to', { from, to })
        .execute();
    }
  }
}

function toResponse(folder: TripFolder): TripFolderResponseDto {
  return {
    id: folder.id,
    user_id: folder.user_id,
    name: folder.name,
    color: folder.color,
    position: folder.position,
    created_at: folder.created_at.toISOString(),
    updated_at: folder.updated_at.toISOString(),
  };
}

function normaliseColor(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}
