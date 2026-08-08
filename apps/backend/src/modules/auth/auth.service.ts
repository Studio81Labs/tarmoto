import {
  Injectable,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { resolveLocale } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { toUserResponse } from '../users/user-response.mapper.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { AppSettingsService } from '../app-settings/app-settings.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { EmailVerificationService } from './email-verification.service.js';
import { AuthResponseDto } from './dto/auth-response.dto.js';

const ACCESS_TOKEN_EXPIRY = 60 * 60; // 1 hour
const REFRESH_TOKEN_EXPIRY = 90 * 24 * 60 * 60; // 90 days
const BCRYPT_ROUNDS = 12;
// Dummy hash for constant-time login rejection when user not found
const DUMMY_HASH =
  '$2b$12$000000000000000000000uGhtZ2nTis4GxVpCR7tOZXaKQfGKqaJi';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwt: JwtService,
    private readonly emailVerification: EmailVerificationService,
    private readonly featureResolver: FeatureResolver,
    private readonly appSettings: AppSettingsService,
  ) {}

  async register(dto: RegisterDto, acceptLanguage?: string) {
    const password_hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Launch mode (sibling `launch_all_pro` pattern): while an operator
    // has a launch tier set, every new registration starts on that tier,
    // marked `founder` so the grant stays distinguishable from a paid
    // subscription. Existing accounts are never touched.
    const { tier: launchTier } = await this.appSettings.getLaunchTier();

    const user = this.userRepo.create({
      email: dto.email,
      password_hash,
      display_name: dto.display_name,
      // Best-effort capture of the rider's browser/OS locale from the
      // registration request. `resolveLocale` falls back to
      // `DEFAULT_LOCALE` for a missing header or an unregistered tag, so
      // this is always safe to set. Only the value is seeded here — the
      // verification-email send stays on its own locale wiring.
      language: resolveLocale(acceptLanguage),
      // DUAL-WRITE while the grant columns are being introduced (#1132).
      //
      // `grant_tier`/`grant_source` are the new home for grant entitlement;
      // `subscription_tier`/`plan_source` are still what every reader consults,
      // so both are written and kept identical. Entitlement resolves as
      // `max(grant, subscription)`, which returns the same value either way, so
      // this changes nothing today. Once readers move onto `resolveEntitledTier`
      // the subscription side of this write goes away and a launch grant stops
      // being reachable by Stripe writers at all — which is the point.
      ...(launchTier
        ? {
            subscription_tier: launchTier,
            plan_source: 'founder' as const,
            grant_tier: launchTier,
            grant_source: 'founder' as const,
            grant_granted_at: new Date(),
          }
        : {}),
    });

    let saved: User;
    try {
      saved = await this.userRepo.save(user);
    } catch (err: unknown) {
      // PostgreSQL unique_violation code
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }

    // Best-effort verification email. A token row is persisted inside
    // `issueAndSend`, so even if the mail provider hiccups the user
    // can hit `/auth/resend-verification` later without losing
    // anything. Wrapped here as a final safety net so a never-thrown-
    // before exception inside the verification path can't 500 the
    // register response.
    try {
      await this.emailVerification.issueAndSend(saved);
    } catch (err) {
      this.logger.warn(
        `Failed to issue verification email for user ${saved.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return this.buildAuthResponse(saved);
  }

  async login(dto: LoginDto) {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email: dto.email })
      .getOne();
    // Always run bcrypt.compare to prevent timing-based email enumeration
    const hash = user?.password_hash || DUMMY_HASH;
    const valid = await bcrypt.compare(dto.password, hash);
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Soft-deleted accounts are locked out immediately. Mirror the
    // generic "Invalid credentials" message to avoid leaking the
    // account-status side-channel — a user whose account was scheduled
    // for deletion shouldn't be distinguishable from a wrong password
    // to an attacker probing the login endpoint.
    if (user.deleted_at != null) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildAuthResponse(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; type: string; orig_iat?: number; iat?: number };
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    // Enforce maximum session lifetime from original login
    const sessionStart = payload.orig_iat ?? payload.iat ?? 0;
    const ageSeconds = Math.floor(Date.now() / 1000) - sessionStart;
    if (ageSeconds > REFRESH_TOKEN_EXPIRY) {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.deleted_at != null) {
      throw new UnauthorizedException('User not found');
    }

    // Force-invalidate any session whose original-issue time is older
    // than the user's last password change. Without this, an attacker
    // who already stole a refresh token would keep minting access
    // tokens for the full 90-day refresh-token lifetime even after
    // the legitimate owner reset their password. The 1-hour access-
    // token TTL bounds how long a stolen access token still works
    // after the reset.
    //
    // Both sides of the comparison are floored to whole seconds. JWT
    // `orig_iat` is `Math.floor(Date.now() / 1000)` at issuance, so
    // sub-second precision on `password_changed_at` would otherwise
    // flag a session issued *later in the same second* as the reset
    // as predating it (sessionStart * 1000 < ms-precision change
    // time → falsely rejected). Comparing in seconds preserves the
    // 1-second slop window — acceptable since 90-day stolen-refresh-
    // token survival was the threat we cared about.
    if (user.password_changed_at != null) {
      const passwordChangedSec = Math.floor(
        user.password_changed_at.getTime() / 1000,
      );
      if (sessionStart < passwordChangedSec) {
        throw new UnauthorizedException('Session expired, please log in again');
      }
    }

    return this.buildAuthResponse(user, sessionStart);
  }

  private async buildAuthResponse(
    user: User,
    origIat?: number,
  ): Promise<AuthResponseDto> {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = this.jwt.sign(
      { sub: user.id, type: 'access' },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    const refreshToken = this.jwt.sign(
      { sub: user.id, type: 'refresh', orig_iat: origIat ?? now },
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );

    // `toUserResponse` is the shared mapper that `/users/me` also uses,
    // so login / register / refresh hand back the same rich profile
    // shape — mobile reads `user.preferences.crash_detection` and the
    // rest of the profile fields immediately on login, no follow-up
    // `/users/me` call needed.
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_EXPIRY,
      user: toUserResponse(
        user,
        await this.featureResolver.resolveEntitlementsForLoadedUser(user),
      ),
    };
  }
}
