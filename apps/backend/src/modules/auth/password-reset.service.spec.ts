/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { PasswordResetService } from './password-reset.service.js';
import { EmailService } from '../email/email.service.js';
import { PasswordResetToken } from '../../entities/password-reset-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { hashToken } from './token-utils.js';

describe('PasswordResetService', () => {
  let service: PasswordResetService;
  let tokenRepo: {
    insert: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepo: { findOne: jest.Mock; update: jest.Mock };
  let txManager: { update: jest.Mock; insert: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let email: {
    sendPasswordReset: jest.Mock;
    sendPasswordChanged: jest.Mock;
  };

  const buildUser = (): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Rider',
      deleted_at: null,
      password_hash: 'old-hash',
      language: 'en',
    }) as unknown as User;

  beforeEach(async () => {
    tokenRepo = {
      insert: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
    userRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    txManager = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'tok-x' }] }),
    };
    dataSource = {
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) =>
          cb(txManager as unknown as EntityManager),
      ),
    };

    email = {
      sendPasswordReset: jest.fn().mockResolvedValue(null),
      sendPasswordChanged: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        {
          provide: getRepositoryToken(PasswordResetToken),
          useValue: tokenRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TARMOTO_COMPANION_URL'
                ? 'https://app.tarmoto.app'
                : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(PasswordResetService);
  });

  describe('requestReset', () => {
    it('issues a 15-minute hashed token and emails the reset link to a known user', async () => {
      userRepo.findOne.mockResolvedValue(buildUser());

      await service.requestReset('rider@tarmoto.app', '203.0.113.5');

      // Token rotation runs in a transaction now: the prior-token
      // UPDATE and the fresh-token INSERT are both routed through the
      // transaction manager, gated by `uniq_password_reset_active` so
      // concurrent requests can't end up with two live tokens.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(txManager.update).toHaveBeenCalledWith(
        PasswordResetToken,
        expect.objectContaining({
          user_id: 'user-1',
          consumed_at: expect.any(Object),
        }),
        expect.objectContaining({ consumed_at: expect.any(Date) }),
      );
      expect(txManager.insert).toHaveBeenCalledTimes(1);
      const inserted = txManager.insert.mock.calls[0][1] as {
        user_id: string;
        token_hash: string;
        expires_at: Date;
        requested_ip: string | null;
      };
      expect(inserted.user_id).toBe('user-1');
      expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted.requested_ip).toBe('203.0.113.5');
      const ttlMs = inserted.expires_at.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 100);

      expect(email.sendPasswordReset).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({
          displayName: 'Rider',
          expiresInMinutes: 15,
          resetUrl: expect.stringMatching(
            /^https:\/\/app\.tarmoto\.app\/reset-password\?token=/,
          ),
        }),
        // Recipient's stored language, not the service default.
        'en',
      );
    });

    it('silently no-ops for an unknown email (anti-enumeration)', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await service.requestReset('ghost@nowhere.example', null);

      expect(txManager.insert).not.toHaveBeenCalled();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('silently no-ops for a soft-deleted account', async () => {
      userRepo.findOne.mockResolvedValue({
        ...buildUser(),
        deleted_at: new Date(),
      });

      await service.requestReset('rider@tarmoto.app', null);

      expect(txManager.insert).not.toHaveBeenCalled();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('treats a unique-violation as a concurrent request and skips the email', async () => {
      userRepo.findOne.mockResolvedValue(buildUser());
      // Simulate the partial unique index firing on a concurrent insert.
      const uniqErr = Object.assign(new Error('duplicate key value'), {
        code: '23505',
      });
      txManager.insert.mockRejectedValueOnce(uniqErr);

      await expect(
        service.requestReset('rider@tarmoto.app', null),
      ).resolves.toBeUndefined();

      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('consumeReset', () => {
    it('hashes the new password and emails a password-changed confirmation', async () => {
      const rawToken = 'plaintext-reset-token-1234567890';
      tokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        user_id: 'user-1',
        token_hash: hashToken(rawToken),
        consumed_at: null,
        expires_at: new Date(Date.now() + 60_000),
      });
      userRepo.findOne.mockResolvedValue(buildUser());

      await service.consumeReset(rawToken, 'new-secure-password');

      const qb = tokenRepo.createQueryBuilder.mock.results[0]?.value as {
        execute: jest.Mock;
      };
      expect(qb.execute).toHaveBeenCalled();
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        expect.objectContaining({
          password_hash: expect.stringMatching(/^\$2[ab]\$/),
          // Stamp the cutoff so AuthService.refresh rejects any
          // refresh token whose `orig_iat` predates the reset.
          password_changed_at: expect.any(Date),
        }),
      );
      expect(email.sendPasswordChanged).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({
          displayName: 'Rider',
          changedAt: expect.any(Date),
        }),
        // Recipient's stored language, not the service default.
        'en',
      );
    });

    it('rejects an expired token without rotating the password', async () => {
      const rawToken = 'expired-1234567890';
      tokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        user_id: 'user-1',
        token_hash: hashToken(rawToken),
        consumed_at: null,
        expires_at: new Date(Date.now() - 60_000),
      });

      await expect(
        service.consumeReset(rawToken, 'new-password'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });
});
