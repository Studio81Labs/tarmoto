import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { EmailVerificationToken } from '../../entities/email-verification-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import { hashToken, issueToken } from './token-utils.js';

const VERIFY_TOKEN_TTL_HOURS = 24;
const VERIFY_TOKEN_TTL_MS = VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000;

// Postgres unique_violation SQLSTATE.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Issuance + consumption of `email_verification_tokens`. Kept
 * separate from `AuthService` so the registration / login path
 * doesn't grow yet another responsibility, and so the email-related
 * test surface is focused.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @InjectRepository(EmailVerificationToken)
    private readonly tokenRepo: Repository<EmailVerificationToken>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a fresh verification token for `user` and email it. Best-
   * effort: a transient mail-provider failure must NOT bubble up to
   * the registration response, since the token is already persisted
   * and the user can request a resend.
   */
  async issueAndSend(user: User): Promise<void> {
    const token = issueToken();
    const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

    // Invalidate any prior un-consumed token AND insert the fresh one
    // inside a single transaction. Mirrors the password-reset flow:
    // a stolen verification link stops working the moment the
    // legitimate user clicks "send me another verification email."
    // The `uniq_email_verification_active` partial unique index
    // (migration 1715900000000) guarantees at most one row per user
    // with `consumed_at IS NULL`. If two concurrent issueAndSend
    // calls race here (e.g. register + first resend overlap), the
    // slower one hits the unique violation; we treat that as "the
    // other request already issued a fresh token" so the user gets
    // one valid email, not two.
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          EmailVerificationToken,
          { user_id: user.id, consumed_at: IsNull() },
          { consumed_at: new Date() },
        );
        await manager.insert(EmailVerificationToken, {
          user_id: user.id,
          token_hash: token.hash,
          expires_at: expiresAt,
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
          `Concurrent verification issuance for user ${user.id} — relying on the winner's token; not sending a duplicate email.`,
        );
        return;
      }
      throw err;
    }

    const verifyUrl = `${getCompanionUrl(this.config)}/verify-email?token=${encodeURIComponent(
      token.raw,
    )}`;

    try {
      await this.email.sendVerification(user.email, {
        displayName: user.display_name,
        verifyUrl,
        expiresInHours: VERIFY_TOKEN_TTL_HOURS,
      });
    } catch (err) {
      this.logger.warn(
        `Verification email send failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }. Token is still valid; user can request a resend.`,
      );
    }
  }

  /**
   * Resend a verification token to the authenticated user. No-op (and
   * still 204 to the caller) if the user is already verified — the
   * controller decides the response shape.
   */
  async resend(userId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.email_verified_at != null) return;
    await this.issueAndSend(user);
  }

  /**
   * Consume a verification token. Atomic: a token is single-use and
   * can't be replayed even if two tabs submit the link concurrently.
   * The `consumed_at IS NULL AND expires_at > now()` predicate guards
   * the update so the loser of a race sees `affected: 0` and gets the
   * generic "expired or already used" response.
   */
  async verify(rawToken: string): Promise<{ verified: true }> {
    const tokenHash = hashToken(rawToken);
    const now = new Date();

    const tokenRow = await this.tokenRepo.findOne({
      where: {
        token_hash: tokenHash,
        consumed_at: IsNull(),
      },
    });
    if (!tokenRow || tokenRow.expires_at <= now) {
      throw new BadRequestException(
        'Verification link is invalid or has expired',
      );
    }

    const claim = await this.tokenRepo
      .createQueryBuilder()
      .update(EmailVerificationToken)
      .set({ consumed_at: now })
      .where('id = :id', { id: tokenRow.id })
      .andWhere('consumed_at IS NULL')
      .andWhere('expires_at > :now', { now })
      .execute();

    if (!claim.affected) {
      throw new BadRequestException(
        'Verification link is invalid or has expired',
      );
    }

    await this.userRepo.update(
      { id: tokenRow.user_id, email_verified_at: IsNull() },
      { email_verified_at: now },
    );

    this.logger.log(`User ${tokenRow.user_id} verified email`);
    return { verified: true };
  }

  /**
   * Garbage-collect expired verification tokens. The 24h TTL plus the
   * `consumed_at IS NULL AND expires_at > now()` consumption predicate
   * make replay impossible regardless of pruning, but rows accumulate
   * forever otherwise — every register and every resend leaves one
   * behind. The daily cron below keeps the table bounded.
   */
  async pruneExpired(now: Date = new Date()): Promise<number> {
    const res = await this.tokenRepo.delete({
      expires_at: LessThanOrEqual(now),
    });
    return res.affected ?? 0;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'email-verification-token-prune',
  })
  async runScheduledPrune(): Promise<void> {
    try {
      const pruned = await this.pruneExpired();
      if (pruned > 0) {
        this.logger.log(`Pruned ${pruned} expired email-verification token(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `Scheduled email-verification prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
