/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  STRIPE_BILLING_CLIENT,
  type StripeBillingClient,
} from './stripe-billing.client.js';
import { EmailService } from '../email/email.service.js';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { User } from '../../entities/user.entity.js';
import { HazardPhotoUpload } from '../../entities/hazard-photo-upload.entity.js';
import {
  HAZARD_PHOTO_UPLOAD_DIR,
  hazardPhotoUploadLockKey,
} from '../hazards/dto/hazard-photo.dto.js';
import { AccountDeletionLog } from '../../entities/account-deletion-log.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { EmailLog } from '../../entities/email-log.entity.js';

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let userRepo: jest.Mocked<Pick<Repository<User>, 'find' | 'findOne'>> & {
    createQueryBuilder: jest.Mock;
  };
  let hazardPhotoUploadRepo: { find: jest.Mock; delete: jest.Mock };
  let stripe: jest.Mocked<StripeBillingClient>;
  let dataSource: { transaction: jest.Mock };
  let txManager: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let surfaceUpdateExecute: jest.Mock;

  const KNOWN_PASSWORD = 'correcthorse';
  let knownHash: string;

  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      password_hash: knownHash,
      display_name: 'Test Rider',
      phone: null,
      avatar_url: null,
      bio: null,
      language: 'en',
      home_region: null,
      home_location: null,
      work_location: null,
      preferences: {},
      stripe_customer_id: null,
      stripe_subscription_id: null,
      subscription_tier: 'free',
      subscription_status: 'canceled',
      subscription_cancel_at_period_end: false,
      subscription_current_period_end: null,
      billing_trial_used_at: null,
      email_verified_at: new Date('2026-04-01T00:00:00Z'),
      deleted_at: null,
      deletion_scheduled_at: null,
      deletion_reason: null,
      created_at: new Date('2026-04-01T00:00:00Z'),
      updated_at: new Date('2026-04-01T00:00:00Z'),
      ...overrides,
    }) as User;

  beforeAll(async () => {
    knownHash = await bcrypt.hash(KNOWN_PASSWORD, 4);
  });

  beforeEach(async () => {
    surfaceUpdateExecute = jest.fn().mockResolvedValue({ affected: 0 });
    txManager = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: surfaceUpdateExecute,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // Advisory-lock acquisition inside the purge transaction.
      query: jest.fn().mockResolvedValue([]),
      // Pending hazard-photo snapshot now runs inside the transaction (under
      // the lock). Default: no pending uploads.
      find: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((_entity, payload: Record<string, unknown>) => ({
          ...payload,
        })),
      save: jest.fn().mockImplementation((_entity, payload) => payload),
    };

    dataSource = {
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) => {
          return cb(txManager as unknown as EntityManager);
        },
      ),
    };

    const userQb = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(buildUser()),
    };
    userRepo = {
      find: jest.fn().mockResolvedValue([]),
      // Pre-flight existence check used by `purgeUser` — default to
      // "row still present" so the existing tests don't have to
      // explicitly mock it.
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id } as User),
        ),
      createQueryBuilder: jest.fn().mockReturnValue(userQb),
    };

    hazardPhotoUploadRepo = {
      // Default: the rider has no pending uploads.
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    stripe = {
      ensureCustomer: jest.fn(),
      getBillingSnapshot: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
      cancelSubscription: jest.fn().mockResolvedValue(undefined),
      deleteCustomer: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(true),
      constructWebhookEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: getRepositoryToken(HazardPhotoUpload),
          useValue: hazardPhotoUploadRepo,
        },
        {
          provide: getDataSourceToken(),
          useValue: dataSource,
        },
        { provide: STRIPE_BILLING_CLIENT, useValue: stripe },
        {
          provide: EmailService,
          useValue: {
            sendAccountDeletionScheduled: jest.fn().mockResolvedValue(null),
            sendAccountDeletionCompleted: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TARMOTO_ACCOUNT_DELETION_GRACE_DAYS'
                ? undefined
                : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AccountDeletionService>(AccountDeletionService);
  });

  describe('requestDeletion (soft delete)', () => {
    it('schedules the user for deletion 30 days out and writes a requested audit row', async () => {
      const user = buildUser();
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(user);

      const before = Date.now();
      const result = await service.requestDeletion('user-1', {
        password: KNOWN_PASSWORD,
        reason: 'no longer riding',
      });
      const after = Date.now();

      expect(result.status).toBe('scheduled');
      expect(result.grace_period_days).toBe(30);

      const scheduledMs = new Date(result.scheduled_for).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(scheduledMs - before).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
      expect(scheduledMs - after).toBeLessThanOrEqual(thirtyDaysMs + 1000);

      // Soft-delete + audit insert run inside the same transaction so a
      // failed audit write rolls the account-lock back. Both writes
      // therefore land on the txManager, not on a top-level repo. The
      // UPDATE is gated on `deleted_at IS NULL` so a concurrent submit
      // can't double-write the schedule or audit row.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(txManager.update).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          id: 'user-1',
          deleted_at: expect.objectContaining({ _type: 'isNull' }),
        }),
        expect.objectContaining({
          deleted_at: expect.any(Date),
          deletion_scheduled_at: expect.any(Date),
          deletion_reason: 'no longer riding',
        }),
      );
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          user_id: 'user-1',
          email: 'rider@tarmoto.app',
          event: 'requested',
          details: { reason: 'no longer riding' },
        }),
      );
      // Scheduled-deletion notice goes out in the rider's stored language.
      const email = service['email'] as unknown as {
        sendAccountDeletionScheduled: jest.Mock;
      };
      expect(email.sendAccountDeletionScheduled).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({ displayName: 'Test Rider' }),
        'en',
      );
    });

    it("is idempotent under concurrent submits — the loser returns the winner's schedule and writes no audit row", async () => {
      // Two near-simultaneous DELETE /account requests both pass the
      // pre-check, but only one wins the conditional UPDATE
      // (deleted_at IS NULL). The loser sees affected: 0, skips the
      // audit, and re-reads the row to return the winner's schedule.
      const winningSchedule = new Date('2026-05-26T08:00:00.000Z');
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());
      // Simulate a parallel transaction having already committed.
      txManager.update.mockResolvedValueOnce({ affected: 0 });
      // The fall-back read returns the winner's committed schedule.
      userRepo.findOne.mockResolvedValueOnce({
        id: 'user-1',
        deletion_scheduled_at: winningSchedule,
      } as User);

      const result = await service.requestDeletion('user-1', {
        password: KNOWN_PASSWORD,
        reason: 'duplicate submit',
      });

      // Both submits see the same `scheduled` response with the
      // winner's schedule — the rider's experience is identical.
      expect(result).toEqual({
        status: 'scheduled',
        scheduled_for: winningSchedule.toISOString(),
        grace_period_days: 30,
      });
      // Critically: no second `requested` audit row, no overwritten
      // schedule. The compliance log stays clean.
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('rolls the soft-delete back if the audit insert fails', async () => {
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());
      // Simulate a transient DB failure on the audit insert. The
      // transaction wrapper rejects, so the user.update is rolled back
      // — the account is not locked-but-unaudited.
      txManager.save.mockRejectedValueOnce(new Error('audit insert failed'));

      await expect(
        service.requestDeletion('user-1', { password: KNOWN_PASSWORD }),
      ).rejects.toThrow('audit insert failed');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('rejects with 403 (not 401) when the password does not match — companion treats 401 as session expiry', async () => {
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());

      await expect(
        service.requestDeletion('user-1', { password: 'wrong' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the account is already pending deletion', async () => {
      userRepo
        .createQueryBuilder()
        .getOne.mockResolvedValueOnce(
          buildUser({ deleted_at: new Date('2026-04-20T00:00:00Z') }),
        );

      await expect(
        service.requestDeletion('user-1', { password: KNOWN_PASSWORD }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects with 404 when the user does not exist', async () => {
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(null);

      await expect(
        service.requestDeletion('user-missing', { password: KNOWN_PASSWORD }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('honours TARMOTO_ACCOUNT_DELETION_GRACE_DAYS override', async () => {
      const config = service['config'] as { get: jest.Mock };
      config.get.mockImplementation((key: string) =>
        key === 'TARMOTO_ACCOUNT_DELETION_GRACE_DAYS' ? '7' : undefined,
      );
      userRepo.createQueryBuilder().getOne.mockResolvedValueOnce(buildUser());

      const result = await service.requestDeletion('user-1', {
        password: KNOWN_PASSWORD,
      });

      expect(result.grace_period_days).toBe(7);
    });
  });

  describe('processDueDeletions (hard delete sweeper)', () => {
    it('cancels Stripe and purges users whose grace window has elapsed', async () => {
      const due = buildUser({
        id: 'expired-1',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc',
        deletion_reason: 'gdpr',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
      expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_abc');
      // surface_readings anonymization happens via the `ON DELETE SET
      // NULL` FK cascade triggered by the user delete below — the
      // service must NOT run a separate UPDATE, otherwise a restore
      // race (delete affected: 0) would orphan the user's telemetry
      // even though the user row is preserved.
      expect(surfaceUpdateExecute).not.toHaveBeenCalled();
      // The delete carries the same predicate as the sweeper's
      // snapshot query — `deleted_at IS NOT NULL AND
      // deletion_scheduled_at <= now`. A support agent who restored
      // (cleared `deleted_at`) OR postponed (pushed
      // `deletion_scheduled_at` into the future) between pre-flight
      // and this transaction is honoured: the delete returns
      // affected: 0 and the audit is skipped.
      expect(txManager.delete).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          id: 'expired-1',
          deleted_at: expect.objectContaining({ _type: 'not' }),
          deletion_scheduled_at: expect.objectContaining({
            _type: 'lessThanOrEqual',
          }),
        }),
      );
      // Pending trip invites are keyed by email — no FK cascade reaches
      // them, so the purge must delete them explicitly.
      expect(txManager.delete).toHaveBeenCalledWith(TripInvite, {
        email: 'rider@tarmoto.app',
      });
      // The email delivery log is likewise recipient-keyed, so the rider's
      // address doesn't survive the purge.
      expect(txManager.delete).toHaveBeenCalledWith(EmailLog, {
        recipient: 'rider@tarmoto.app',
      });
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          user_id: 'expired-1',
          email: 'rider@tarmoto.app',
          event: 'purged',
          stripe_customer_id: 'cus_abc',
          stripe_subscription_id: 'sub_abc',
          details: expect.objectContaining({
            stripe_subscription_canceled: true,
            stripe_customer_deleted: true,
            deletion_reason: 'gdpr',
          }),
        }),
      );
    });

    it('purges the rider pending hazard-photo upload rows AND unlinks their files', async () => {
      // GDPR hard-purge: the tracking rows (no FK to users) and the on-disk
      // files both embed the rider's UUID and must not survive the account.
      const due = buildUser({
        id: 'expired-2',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      const filename = 'expired-2-1700000000000-abc.jpg';
      txManager.find.mockResolvedValueOnce([{ filename }]);
      await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });
      const filePath = join(HAZARD_PHOTO_UPLOAD_DIR, filename);
      await writeFile(filePath, 'bytes');

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      // File unlinked after the commit, then its tracking row dropped.
      await expect(access(filePath)).rejects.toThrow();
      expect(hazardPhotoUploadRepo.delete).toHaveBeenCalledWith({ filename });
    });

    it('serializes the pending-photo snapshot behind the per-user upload advisory lock', async () => {
      // Codex P2: an in-flight `POST /hazards/photos` must not insert a row the
      // purge snapshot misses. The purge acquires the SAME advisory key
      // uploadPhoto holds, so the snapshot can't race an upload's insert.
      const due = buildUser({
        id: 'expired-lock',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);

      await service.processDueDeletions(new Date('2026-04-01T00:00:00Z'));

      expect(txManager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [hazardPhotoUploadLockKey('expired-lock')],
      );
      // The lock is taken before the pending-photo snapshot reads any row.
      const lockCallOrder: number = txManager.query.mock.invocationCallOrder[0];
      const snapshotCallOrder: number =
        txManager.find.mock.invocationCallOrder[0];
      expect(lockCallOrder).toBeLessThan(snapshotCallOrder);
    });

    it('RETAINS a pending-photo row for the sweep when its unlink fails on purge', async () => {
      // Codex P1: a failed unlink must not drop the tracking row — the file
      // would then leak forever (the sweep can no longer find it). Keep the row
      // so the hourly sweep retries.
      const due = buildUser({
        id: 'expired-4',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      const filename = 'expired-4-1700000000000-stuck.jpg';
      txManager.find.mockResolvedValueOnce([{ filename }]);
      await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });
      // A directory at the path forces unlink to throw EISDIR.
      await mkdir(join(HAZARD_PHOTO_UPLOAD_DIR, filename), { recursive: true });

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      // Row NOT dropped — retained for the sweep to retry.
      expect(hazardPhotoUploadRepo.delete).not.toHaveBeenCalled();
      await rm(join(HAZARD_PHOTO_UPLOAD_DIR, filename), {
        recursive: true,
        force: true,
      });
    });

    it('RETAINS a pending-photo row on ENOENT (a committed upload not yet written)', async () => {
      // Codex P1 (write-after-commit race): `uploadPhoto` commits its tracking
      // row BEFORE writing the file (its advisory lock releases at that commit),
      // so a stalled upload has a row here with no file yet. Deleting the row on
      // ENOENT would strand the file the writer is about to create with no
      // tracking row — invisible to the table-driven sweep. The row MUST be
      // retained so the grace-bounded sweep reclaims it.
      const due = buildUser({
        id: 'expired-5',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      const filename = 'expired-5-1700000000000-inflight.jpg';
      txManager.find.mockResolvedValueOnce([{ filename }]);
      await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });
      // No file on disk for this filename → unlink throws ENOENT.

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      // Row NOT dropped — ENOENT is ambiguous with not-yet-written; the sweep
      // is the safe owner.
      expect(hazardPhotoUploadRepo.delete).not.toHaveBeenCalled();
    });

    it('LOGS (does not swallow) a tracking-row delete failure after a successful unlink', async () => {
      // Codex P2: when the file unlink succeeds but the row delete fails
      // transiently, the purge must still succeed BUT surface the lingering row
      // (carries the rider's UUID) — a silent swallow would hide personal data
      // outliving finalization until the 24h sweep.
      const due = buildUser({
        id: 'expired-6',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      const filename = 'expired-6-1700000000000-stuck-row.jpg';
      txManager.find.mockResolvedValueOnce([{ filename }]);
      await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });
      const filePath = join(HAZARD_PHOTO_UPLOAD_DIR, filename);
      await writeFile(filePath, 'bytes');
      hazardPhotoUploadRepo.delete.mockRejectedValueOnce(new Error('db blip'));
      const warnSpy = jest
        .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
        .mockImplementation(() => undefined);

      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      // Purge still reports success; the file was removed.
      expect(purged).toBe(1);
      await expect(access(filePath)).rejects.toThrow();
      // The delete failure was attempted and surfaced (not swallowed).
      expect(hazardPhotoUploadRepo.delete).toHaveBeenCalledWith({ filename });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(filename));
      warnSpy.mockRestore();
    });

    it('does not unlink pending photo files when the purge does not happen (restore race)', async () => {
      const due = buildUser({
        id: 'expired-3',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      const filename = 'expired-3-1700000000000-keep.jpg';
      txManager.find.mockResolvedValueOnce([{ filename }]);
      await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });
      const filePath = join(HAZARD_PHOTO_UPLOAD_DIR, filename);
      await writeFile(filePath, 'bytes');
      // Support restored / concurrent sweeper: the user delete affects 0 rows.
      txManager.delete.mockResolvedValueOnce({ affected: 0 });

      await service.processDueDeletions(new Date('2026-04-01T00:00:00Z'));

      // File preserved — the account was NOT purged.
      await expect(access(filePath)).resolves.toBeUndefined();
      await rm(filePath, { force: true });
    });

    it('emails the deletion-completed receipt using the language captured BEFORE the purge (the row is gone by send time)', async () => {
      const due = buildUser({
        id: 'expired-lang',
        email: 'lang-rider@tarmoto.app',
        display_name: 'Lang Rider',
        language: 'en',
        deleted_at: new Date('2026-03-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-03-31T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);
      // The purge pre-flight's OWN findOne (inside `purgeUser`) only ever
      // returns `{ id }` (see the default `userRepo.findOne` mock above) —
      // so if the implementation regressed to reading `language` from that
      // re-fetch instead of the value captured before the purge, this
      // would surface as `undefined` here instead of the seeded 'en'.
      const purged = await service.processDueDeletions(
        new Date('2026-04-01T00:00:00Z'),
      );

      expect(purged).toBe(1);
      const email = service['email'] as unknown as {
        sendAccountDeletionCompleted: jest.Mock;
      };
      expect(email.sendAccountDeletionCompleted).toHaveBeenCalledWith(
        'lang-rider@tarmoto.app',
        expect.objectContaining({ displayName: 'Lang Rider' }),
        'en',
      );
    });

    it('skips Stripe entirely when billing is not configured', async () => {
      stripe.isConfigured.mockReturnValue(false);
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_orphan',
        stripe_subscription_id: 'sub_orphan',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      await service.processDueDeletions(new Date('2026-04-02T00:00:00Z'));

      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.deleteCustomer).not.toHaveBeenCalled();
      expect(txManager.delete).toHaveBeenCalled();
    });

    it('still attempts deleteCustomer when cancelSubscription fails (avoids orphaned Stripe customers)', async () => {
      // Regression: previously a single try/catch wrapped both Stripe
      // calls, so a transient cancelSubscription failure short-circuited
      // deleteCustomer and permanently orphaned the Stripe customer
      // (the user row is gone after this returns, so the sweeper can
      // never retry). Each call now has its own try/catch.
      stripe.cancelSubscription.mockRejectedValueOnce(new Error('stripe down'));
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(1);
      // deleteCustomer must still run and succeed even though
      // cancelSubscription threw — Stripe's customer.del cascades
      // subscription cancellation server-side.
      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
      expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_abc');
      expect(txManager.delete).toHaveBeenCalled();
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          details: expect.objectContaining({
            stripe_subscription_canceled: false,
            stripe_customer_deleted: true,
            stripe_errors: ['cancelSubscription: stripe down'],
          }),
        }),
      );
    });

    it('records both Stripe errors when cancelSubscription and deleteCustomer both fail', async () => {
      stripe.cancelSubscription.mockRejectedValueOnce(new Error('cancel fail'));
      stripe.deleteCustomer.mockRejectedValueOnce(new Error('delete fail'));
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      // GDPR compliance wins over Stripe cleanup — the DB row still
      // gets purged on schedule even when both Stripe calls fail.
      // Audit log captures both errors so ops can manually clean up.
      expect(purged).toBe(1);
      expect(txManager.delete).toHaveBeenCalled();
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          details: expect.objectContaining({
            stripe_subscription_canceled: false,
            stripe_customer_deleted: false,
            stripe_errors: [
              'cancelSubscription: cancel fail',
              'deleteCustomer: delete fail',
            ],
          }),
        }),
      );
    });

    it('skips the Stripe calls entirely when a concurrent sweeper already deleted the user', async () => {
      // Cheap pre-flight existence check: if the user row is gone by
      // the time we get to processing, don't burn metered Stripe calls
      // on something another worker has already cleaned up.
      userRepo.findOne.mockResolvedValueOnce(null);
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_already_handled',
        stripe_subscription_id: 'sub_already_handled',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(0);
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.deleteCustomer).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('skips Stripe and the purge when support restored the account between the snapshot and the pre-flight (deleted_at IS NOT NULL filter)', async () => {
      // Same null-from-findOne path as the concurrent-sweeper case, but
      // documenting the second cause: support clearing `deleted_at` to
      // restore an account during the grace window. Pre-flight filters
      // on `deleted_at IS NOT NULL`, so a restored row is treated as
      // not-due and the sweeper bails before any irreversible side
      // effect runs.
      userRepo.findOne.mockResolvedValueOnce(null);
      const restored = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_restored',
        stripe_subscription_id: 'sub_restored',
      });
      userRepo.find.mockResolvedValueOnce([restored]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(0);
      // Verify the pre-flight query carries the restore-race filter,
      // not just the existence check.
      expect(userRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: restored.id,
            deleted_at: expect.objectContaining({ _type: 'not' }),
            deletion_scheduled_at: expect.objectContaining({
              _type: 'lessThanOrEqual',
            }),
          }),
        }),
      );
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    });

    it('skips the purge audit row when a concurrent sweeper already deleted the user', async () => {
      // Multiple backend instances run the same hourly cron. If worker A
      // deletes the row first, worker B's manager.delete returns
      // affected = 0; without this skip we would emit a duplicate
      // `purged` audit row, polluting the compliance log.
      txManager.delete.mockResolvedValueOnce({ affected: 0 });
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      // The user wasn't actually deleted by *this* worker, so it
      // doesn't count toward the purge tally and no audit row goes in.
      expect(purged).toBe(0);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('does not delete the user row when support restored the account mid-transaction (delete carries deleted_at IS NOT NULL)', async () => {
      // Tightest race: pre-flight passed (deleted_at was still set),
      // Stripe was called, but support cleared deleted_at before the
      // transaction landed. The delete WHERE clause filters on
      // `deleted_at IS NOT NULL`, so the now-active row is preserved.
      // Stripe was wasted (a tiny window we accept; the alternative is
      // holding a DB transaction open during slow Stripe HTTP calls).
      txManager.delete.mockResolvedValueOnce({ affected: 0 });
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_to_restore',
        stripe_subscription_id: 'sub_to_restore',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(0);
      // Stripe was called (pre-flight passed) but the guarded delete
      // did not touch the row.
      expect(stripe.cancelSubscription).toHaveBeenCalled();
      expect(txManager.delete).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          id: due.id,
          deleted_at: expect.objectContaining({ _type: 'not' }),
          deletion_scheduled_at: expect.objectContaining({
            _type: 'lessThanOrEqual',
          }),
        }),
      );
      // Critically: surface_readings.user_id is NOT updated when the
      // delete is skipped. An earlier version of this code ran the
      // anonymization UPDATE before the delete, which would have
      // permanently orphaned a restored user's telemetry. The
      // ON DELETE SET NULL FK cascade only fires when the delete
      // actually succeeds, so a no-op delete leaves the readings
      // attached to the (now-active) user.
      expect(surfaceUpdateExecute).not.toHaveBeenCalled();
      // No audit row for a row we didn't actually purge.
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('does not delete the user row when support postponed the deletion mid-transaction (delete carries deletion_scheduled_at <= now)', async () => {
      // Sibling race to the restore case: support pushes
      // `deletion_scheduled_at` into the future after pre-flight but
      // before the transaction lands. The delete's
      // `deletion_scheduled_at <= now` predicate makes the now-not-due
      // row return affected: 0, and the user — along with all their
      // data and a still-set `deleted_at` flag — is preserved for the
      // new schedule.
      txManager.delete.mockResolvedValueOnce({ affected: 0 });
      const due = buildUser({
        deleted_at: new Date(),
        deletion_scheduled_at: new Date('2026-04-01T00:00:00Z'),
        stripe_customer_id: 'cus_postponed',
        stripe_subscription_id: 'sub_postponed',
      });
      userRepo.find.mockResolvedValueOnce([due]);

      const purged = await service.processDueDeletions(
        new Date('2026-04-02T00:00:00Z'),
      );

      expect(purged).toBe(0);
      // The delete carries both predicates; affected: 0 makes the
      // postpone case observationally identical to the restore case.
      expect(txManager.delete).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          id: due.id,
          deleted_at: expect.objectContaining({ _type: 'not' }),
          deletion_scheduled_at: expect.objectContaining({
            _type: 'lessThanOrEqual',
          }),
        }),
      );
      expect(surfaceUpdateExecute).not.toHaveBeenCalled();
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('continues the batch when one user fails to purge', async () => {
      const failing = buildUser({ id: 'fail-1' });
      const succeeding = buildUser({ id: 'ok-1', email: 'ok@tarmoto.app' });
      userRepo.find.mockResolvedValueOnce([failing, succeeding]);
      let calls = 0;
      dataSource.transaction.mockImplementation(
        async (cb: (manager: EntityManager) => Promise<unknown>) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('db blew up');
          }
          return cb(txManager as unknown as EntityManager);
        },
      );

      const purged = await service.processDueDeletions();

      expect(purged).toBe(1);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no users are due', async () => {
      userRepo.find.mockResolvedValueOnce([]);
      const purged = await service.processDueDeletions();
      expect(purged).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('does not touch the user row before its scheduled timestamp', async () => {
      // The repository query already filters by `deletion_scheduled_at <= now`,
      // so a user scheduled in the future is simply not returned. This test
      // documents that contract by asserting `userRepo.find` was called with
      // a `LessThanOrEqual(now)` clause.
      const fakeNow = new Date('2026-04-15T00:00:00Z');
      userRepo.find.mockResolvedValueOnce([]);

      await service.processDueDeletions(fakeNow);

      expect(userRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletion_scheduled_at: expect.objectContaining({
              _type: 'lessThanOrEqual',
              _value: fakeNow,
            }),
          }),
        }),
      );
    });
  });

  describe('finalizeUser (per-user queue entry point)', () => {
    it('purges a single eligible user and emails the deletion-completed receipt', async () => {
      const purgedAt = new Date('2026-04-30T00:00:00Z');
      jest.useFakeTimers();
      jest.setSystemTime(purgedAt);
      const target = buildUser({
        id: 'finalize-1',
        email: 'rider@tarmoto.app',
        display_name: 'Final Rider',
        deleted_at: new Date('2026-04-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-04-15T00:00:00Z'),
      });
      userRepo.findOne.mockResolvedValueOnce(target);
      txManager.delete.mockResolvedValueOnce({ affected: 1 });

      const purged = await service.finalizeUser('finalize-1');

      expect(purged).toBe(true);
      expect(txManager.delete).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ id: 'finalize-1' }),
      );
      expect(txManager.save).toHaveBeenCalledWith(
        AccountDeletionLog,
        expect.objectContaining({
          user_id: 'finalize-1',
          email: 'rider@tarmoto.app',
          event: 'purged',
        }),
      );
      const email = service['email'] as {
        sendAccountDeletionCompleted: jest.Mock;
      };
      // Locale comes from the `target` snapshot `finalizeUser` captured
      // BEFORE `purgeUser` ran — the internal pre-flight re-fetch inside
      // `purgeUser` (default `userRepo.findOne` mock) only ever returns
      // `{ id }`, so a value of 'en' here proves the pre-purge capture
      // path, not a post-purge re-read.
      expect(email.sendAccountDeletionCompleted).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({ displayName: 'Final Rider' }),
        'en',
      );
      jest.useRealTimers();
    });

    it('returns false (no email, no audit) when the user is no longer eligible (concurrent purge / restore / postpone)', async () => {
      // The `findOne` query bakes in `deleted_at IS NOT NULL AND deletion_scheduled_at <= NOW()`.
      // A returned `null` means support already restored OR a parallel
      // worker already finished — either way, finalize is a no-op.
      userRepo.findOne.mockResolvedValueOnce(null);

      const purged = await service.finalizeUser('finalize-1');

      expect(purged).toBe(false);
      expect(txManager.delete).not.toHaveBeenCalled();
      expect(txManager.save).not.toHaveBeenCalled();
      const email = service['email'] as {
        sendAccountDeletionCompleted: jest.Mock;
      };
      expect(email.sendAccountDeletionCompleted).not.toHaveBeenCalled();
    });

    it('still returns true when the post-purge confirmation email fails — the row is gone, retrying does nothing', async () => {
      const target = buildUser({
        id: 'finalize-1',
        deleted_at: new Date('2026-04-01T00:00:00Z'),
        deletion_scheduled_at: new Date('2026-04-15T00:00:00Z'),
      });
      userRepo.findOne.mockResolvedValueOnce(target);
      txManager.delete.mockResolvedValueOnce({ affected: 1 });
      const email = service['email'] as {
        sendAccountDeletionCompleted: jest.Mock;
      };
      email.sendAccountDeletionCompleted.mockRejectedValueOnce(
        new Error('Resend 503'),
      );

      const purged = await service.finalizeUser('finalize-1');
      expect(purged).toBe(true);
    });
  });
});
