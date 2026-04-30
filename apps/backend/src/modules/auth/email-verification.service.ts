import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { EmailVerificationToken } from '../../entities/email-verification-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import { hashToken, issueToken } from './token-utils.js';

const VERIFY_TOKEN_TTL_HOURS = 24;
const VERIFY_TOKEN_TTL_MS = VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000;

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

    await this.tokenRepo.insert({
      user_id: user.id,
      token_hash: token.hash,
      expires_at: expiresAt,
    });

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
}
