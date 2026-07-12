import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { PasswordResetToken } from '../../entities/password-reset-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import { hashToken, issueToken } from './token-utils.js';

// Postgres unique_violation SQLSTATE.
const PG_UNIQUE_VIOLATION = '23505';

const RESET_TOKEN_TTL_MINUTES = 15;
const RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MINUTES * 60 * 1000;
const BCRYPT_ROUNDS = 12;

/**
 * `POST /auth/forgot-password` and `POST /auth/reset-password`. Kept
 * separate from `AuthService` so the reset surface (which requires
 * its own anti-enumeration handling and short TTLs) is isolated.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectRepository(PasswordResetToken)
    private readonly tokenRepo: Repository<PasswordResetToken>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a reset token for the given email. Always returns success —
   * the controller responds 204 regardless of whether the user
   * exists, so an attacker can't probe registered addresses by
   * watching response codes.
   *
   * Re-requesting invalidates any prior un-consumed token by stamping
   * `consumed_at = NOW()` on it. This means a stolen previous link
   * stops working the moment the legitimate user clicks "send me
   * another reset email."
   *
   * The user lookup, token writes, and email send all happen here
   * (inside the awaited path) so unit tests can assert on the side
   * effects deterministically. The HTTP-level constant-time
   * guarantee — needed for anti-enumeration — is enforced by the
   * controller, which fires this without awaiting (see
   * `AuthController.forgotPassword`).
   */
  async requestReset(recipientEmail: string, ip: string | null): Promise<void> {
    try {
      await this.processResetRequest(recipientEmail, ip);
    } catch (err) {
      this.logger.warn(
        `Password-reset request failed for ${recipientEmail}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async processResetRequest(
    recipientEmail: string,
    ip: string | null,
  ): Promise<void> {
    const user = await this.userRepo.findOne({
      where: { email: recipientEmail },
    });
    if (!user || user.deleted_at != null) {
      // Anti-enumeration: do nothing, return like we sent the mail.
      return;
    }

    const token = issueToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // Invalidate any prior un-consumed token AND insert the fresh one
    // inside a single transaction. The `uniq_password_reset_active`
    // partial unique index (migration 1715800000000) guarantees at
    // most one row per user with `consumed_at IS NULL`. If two
    // concurrent requests for the same user race here, the slower one
    // hits the unique violation; we treat that as "the other request
    // already issued a fresh token" — the user got an email either
    // way, no need to retry or fail.
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          PasswordResetToken,
          { user_id: user.id, consumed_at: IsNull() },
          { consumed_at: new Date() },
        );
        await manager.insert(PasswordResetToken, {
          user_id: user.id,
          token_hash: token.hash,
          expires_at: expiresAt,
          requested_ip: ip,
        });
      });
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        this.logger.log(
          `Concurrent reset request for user ${user.id} — relying on the winner's token; not sending a duplicate email.`,
        );
        return;
      }
      throw err;
    }

    const resetUrl = `${getCompanionUrl(this.config)}/reset-password?token=${encodeURIComponent(
      token.raw,
    )}`;

    try {
      await this.email.sendPasswordReset(
        user.email,
        {
          displayName: user.display_name,
          resetUrl,
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
        },
        user.language,
      );
    } catch (err) {
      this.logger.warn(
        `Password-reset email send failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Consume a reset token, hash the new password, and confirm with a
   * "your password was changed" email so a hijack attempt is visible
   * to the legitimate owner.
   */
  async consumeReset(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const now = new Date();

    const tokenRow = await this.tokenRepo.findOne({
      where: {
        token_hash: tokenHash,
        consumed_at: IsNull(),
      },
    });
    if (!tokenRow || tokenRow.expires_at <= now) {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    const claim = await this.tokenRepo
      .createQueryBuilder()
      .update(PasswordResetToken)
      .set({ consumed_at: now })
      .where('id = :id', { id: tokenRow.id })
      .andWhere('consumed_at IS NULL')
      .andWhere('expires_at > :now', { now })
      .execute();
    if (!claim.affected) {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    const user = await this.userRepo.findOne({
      where: { id: tokenRow.user_id },
    });
    if (!user || user.deleted_at != null) {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    const password_hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // `password_changed_at` is a hard cutoff: any refresh token whose
    // `orig_iat` is older than this timestamp is rejected by
    // `AuthService.refresh`. Bumping it here means a stolen refresh
    // token stops minting new access tokens within the 1-hour access
    // -token TTL after the legitimate owner completes the reset.
    await this.userRepo.update(
      { id: user.id },
      { password_hash, password_changed_at: now, updated_at: now },
    );

    // Pre-emptively invalidate any other outstanding reset tokens for
    // this user so a parallel attacker-issued reset can't follow up.
    await this.tokenRepo.update(
      { user_id: user.id, consumed_at: IsNull() },
      { consumed_at: now },
    );

    try {
      await this.email.sendPasswordChanged(
        user.email,
        {
          displayName: user.display_name,
          changedAt: now,
        },
        user.language,
      );
    } catch (err) {
      this.logger.warn(
        `Password-changed email send failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.log(`User ${user.id} reset password via token`);
  }

  /**
   * Garbage-collect expired tokens. The unique-hash constraint plus
   * the `consumed_at IS NULL AND expires_at > now()` consumption
   * predicate make replay impossible regardless of pruning, but
   * tokens accumulate forever otherwise — every forgot-password
   * request leaves a row behind. The daily cron below keeps the
   * table bounded.
   */
  async pruneExpired(now: Date = new Date()): Promise<number> {
    const res = await this.tokenRepo.delete({
      expires_at: LessThanOrEqual(now),
    });
    return res.affected ?? 0;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'password-reset-token-prune',
  })
  async runScheduledPrune(): Promise<void> {
    try {
      const pruned = await this.pruneExpired();
      if (pruned > 0) {
        this.logger.log(`Pruned ${pruned} expired password-reset token(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `Scheduled password-reset prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
