import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { PasswordResetToken } from '../../entities/password-reset-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { hashToken, issueToken } from './token-utils.js';

const RESET_TOKEN_TTL_MINUTES = 15;
const RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MINUTES * 60 * 1000;
const BCRYPT_ROUNDS = 12;

const DEFAULT_COMPANION_URL = 'http://localhost:3000';

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
   */
  async requestReset(email: string, ip: string | null): Promise<void> {
    const user = await this.userRepo.findOne({ where: { email } });
    if (!user || user.deleted_at != null) {
      // Anti-enumeration: do nothing, return like we sent the mail.
      return;
    }

    await this.tokenRepo.update(
      {
        user_id: user.id,
        consumed_at: IsNull(),
      },
      { consumed_at: new Date() },
    );

    const token = issueToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await this.tokenRepo.insert({
      user_id: user.id,
      token_hash: token.hash,
      expires_at: expiresAt,
      requested_ip: ip,
    });

    const resetUrl = `${this.companionUrl()}/reset-password?token=${encodeURIComponent(
      token.raw,
    )}`;

    try {
      await this.email.sendPasswordReset(user.email, {
        displayName: user.display_name,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      });
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
    await this.userRepo.update(
      { id: user.id },
      { password_hash, updated_at: now },
    );

    // Pre-emptively invalidate any other outstanding reset tokens for
    // this user so a parallel attacker-issued reset can't follow up.
    await this.tokenRepo.update(
      { user_id: user.id, consumed_at: IsNull() },
      { consumed_at: now },
    );

    try {
      await this.email.sendPasswordChanged(user.email, {
        displayName: user.display_name,
        changedAt: now,
      });
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
   * Garbage-collect expired tokens. Not strictly required (the
   * unique-hash constraint plus the expiry check make replay
   * impossible) but keeps the table from growing without bound.
   * Wired up by the caller — kept on the service so we have one
   * place to add a cron later if needed.
   */
  async pruneExpired(now: Date = new Date()): Promise<number> {
    const res = await this.tokenRepo.delete({
      expires_at: LessThanOrEqual(now),
    });
    return res.affected ?? 0;
  }

  private companionUrl(): string {
    const raw =
      this.config.get<string>('TARMOTO_COMPANION_URL')?.trim() ??
      DEFAULT_COMPANION_URL;
    return raw.replace(/\/$/, '');
  }
}
