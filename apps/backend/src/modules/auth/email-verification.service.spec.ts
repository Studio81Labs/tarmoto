/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { EmailVerificationService } from './email-verification.service.js';
import { EmailService } from '../email/email.service.js';
import { EmailVerificationToken } from '../../entities/email-verification-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { hashToken } from './token-utils.js';

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let tokenRepo: {
    insert: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userRepo: { findOne: jest.Mock; update: jest.Mock };
  let txManager: { update: jest.Mock; insert: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let email: { sendVerification: jest.Mock };

  const buildUser = (): User =>
    ({
      id: 'user-1',
      email: 'rider@tarmoto.app',
      display_name: 'Rider',
      email_verified_at: null,
      language: 'en',
    }) as unknown as User;

  beforeEach(async () => {
    tokenRepo = {
      insert: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    email = { sendVerification: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailVerificationService,
        {
          provide: getRepositoryToken(EmailVerificationToken),
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

    service = module.get(EmailVerificationService);
  });

  describe('issueAndSend', () => {
    it('invalidates prior tokens, persists a hashed token, and emails the verification link', async () => {
      const user = buildUser();
      await service.issueAndSend(user);

      // Token rotation runs in a transaction now — the prior-token
      // UPDATE and the fresh-token INSERT both go through the
      // transaction manager, gated by `uniq_email_verification_active`
      // so concurrent issuance can't end up with two live tokens.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(txManager.update).toHaveBeenCalledWith(
        EmailVerificationToken,
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
      };
      expect(inserted.user_id).toBe('user-1');
      // The plaintext token must NOT be persisted — only the hex
      // SHA-256. Hex is 64 chars; anything shorter would mean we
      // accidentally stored the raw token.
      expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const expiresInMs = inserted.expires_at.getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(23 * 60 * 60 * 1000);

      expect(email.sendVerification).toHaveBeenCalledWith(
        'rider@tarmoto.app',
        expect.objectContaining({
          displayName: 'Rider',
          expiresInHours: 24,
          verifyUrl: expect.stringMatching(
            /^https:\/\/app\.tarmoto\.app\/verify-email\?token=/,
          ),
        }),
        // Recipient's stored language, not the service default.
        'en',
      );
    });

    it('does not propagate transport failures back to the caller', async () => {
      email.sendVerification.mockRejectedValueOnce(new Error('Resend down'));
      await expect(service.issueAndSend(buildUser())).resolves.toBeUndefined();
      expect(txManager.insert).toHaveBeenCalled();
    });

    it('treats a unique-violation as a concurrent issuance and skips the email', async () => {
      // Simulate the partial unique index firing on a concurrent
      // INSERT (e.g. register + a near-simultaneous resend racing
      // for the same user).
      const uniqErr = Object.assign(new Error('duplicate key value'), {
        code: '23505',
      });
      txManager.insert.mockRejectedValueOnce(uniqErr);

      await expect(service.issueAndSend(buildUser())).resolves.toBeUndefined();
      expect(email.sendVerification).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('marks an unconsumed in-window token as consumed and stamps email_verified_at', async () => {
      const rawToken = 'plaintext-token-123456';
      const tokenHash = hashToken(rawToken);
      tokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        user_id: 'user-1',
        token_hash: tokenHash,
        consumed_at: null,
        expires_at: new Date(Date.now() + 60_000),
      });

      const result = await service.verify(rawToken);

      expect(result).toEqual({ verified: true });
      const qb = tokenRepo.createQueryBuilder.mock.results[0]?.value as {
        execute: jest.Mock;
      };
      expect(qb.execute).toHaveBeenCalled();
      expect(userRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ email_verified_at: expect.any(Date) }),
      );
    });

    it('rejects an expired token', async () => {
      const rawToken = 'expired-token-123456';
      tokenRepo.findOne.mockResolvedValue({
        id: 'tok-2',
        user_id: 'user-1',
        token_hash: hashToken(rawToken),
        consumed_at: null,
        expires_at: new Date(Date.now() - 60_000),
      });

      await expect(service.verify(rawToken)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('rejects a missing or already-consumed token', async () => {
      tokenRepo.findOne.mockResolvedValue(null);
      await expect(
        service.verify('does-not-exist-1234567890'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });
});
