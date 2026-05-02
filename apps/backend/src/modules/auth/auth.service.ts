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
import { pointToLatLng } from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
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
  ) {}

  async register(dto: RegisterDto) {
    const password_hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = this.userRepo.create({
      email: dto.email,
      password_hash,
      display_name: dto.display_name,
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

  private buildAuthResponse(user: User, origIat?: number): AuthResponseDto {
    const now = Math.floor(Date.now() / 1000);

    const accessToken = this.jwt.sign(
      { sub: user.id, type: 'access' },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    const refreshToken = this.jwt.sign(
      { sub: user.id, type: 'refresh', orig_iat: origIat ?? now },
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );

    // Match `UsersService.toUserResponse` so login/register/refresh
    // hand the client the same rich profile shape `/users/me` does —
    // mobile reads `user.preferences.crash_detection` and the rest of
    // the profile fields immediately on login, so the slim shape this
    // used to return forced a follow-up `/users/me` call.
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_EXPIRY,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        bio: user.bio,
        home_region: user.home_region,
        home_location: pointToLatLng(user.home_location),
        work_location: pointToLatLng(user.work_location),
        preferences: user.preferences,
        created_at: user.created_at.toISOString(),
      },
    };
  }
}
