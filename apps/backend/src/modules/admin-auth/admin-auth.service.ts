import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AdminUser, type AdminRole } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import {
  ADMIN_ACCESS_TOKEN_SCOPE,
  ADMIN_ACCESS_TOKEN_SECONDS,
  ADMIN_REFRESH_TOKEN_SECONDS,
} from './admin-auth.constants.js';
import { resolveAdminSessionSecret } from './admin-session-secret.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  verifyAdminPassword,
} from './admin-password.js';

export interface AdminUserView {
  id: string;
  email: string;
  role: AdminRole;
  status: 'active' | 'disabled';
}

export interface AdminSessionTokens {
  accessToken: string;
  refreshToken: string;
  user: AdminUserView;
  expiresIn: number;
}

export function serializeAdminUser(user: AdminUser): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
  };
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(AdminUser)
    private readonly users: Repository<AdminUser>,
    @InjectRepository(AdminSession)
    private readonly sessions: Repository<AdminSession>,
    @InjectRepository(AdminRefreshToken)
    private readonly refreshTokens: Repository<AdminRefreshToken>,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AdminSessionTokens> {
    const user = await this.users.findOne({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        password_hash: true,
      },
    });
    if (
      !user ||
      user.status !== 'active' ||
      !user.password_hash ||
      !(await verifyAdminPassword(password, user.password_hash))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.users.update({ id: user.id }, { last_login_at: new Date() });
    return this.createSession(user.id);
  }

  async createSession(adminUserId: string): Promise<AdminSessionTokens> {
    const user = await this.findActiveById(adminUserId);
    if (!user) throw new UnauthorizedException('Invalid admin');

    const now = Date.now();
    const session = await this.sessions.save(
      this.sessions.create({
        admin_user_id: user.id,
        expires_at: new Date(now + ADMIN_REFRESH_TOKEN_SECONDS * 1000),
        last_seen_at: new Date(now),
      }),
    );
    return (await this.issueTokens(user, session.id)).tokens;
  }

  async refresh(rawRefreshToken: string): Promise<AdminSessionTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: tokenHash },
    });
    if (!stored || stored.revoked_at || stored.expires_at <= new Date()) {
      // Reuse of a rotated/expired token: revoke the whole session chain.
      if (stored?.session_id) {
        await this.revokeSession(stored.session_id);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.sessions.findOne({
      where: { id: stored.session_id },
    });
    if (!session || session.revoked_at || session.expires_at <= new Date()) {
      throw new UnauthorizedException('Invalid session');
    }
    const user = await this.findActiveById(session.admin_user_id);
    if (!user) throw new UnauthorizedException('Invalid admin');

    // Rotate: mint a new refresh token, mark the old one replaced+revoked.
    const tokens = await this.issueTokens(user, session.id);
    await this.refreshTokens.update(
      { id: stored.id },
      {
        revoked_at: new Date(),
        last_used_at: new Date(),
        replaced_by_token_id: tokens.refreshTokenId,
      },
    );
    await this.sessions.update(
      { id: session.id },
      { last_seen_at: new Date() },
    );
    return tokens.tokens;
  }

  async revoke(rawRefreshToken: string): Promise<void> {
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: hashRefreshToken(rawRefreshToken) },
    });
    if (stored) await this.revokeSession(stored.session_id);
  }

  async findActiveById(id: string): Promise<AdminUser | null> {
    const user = await this.users.findOne({ where: { id } });
    if (!user || user.status !== 'active') return null;
    return user;
  }

  async findOrProvisionSsoUser(
    provider: string,
    subject: string,
    email: string,
  ): Promise<AdminUser> {
    const normalizedEmail = email.toLowerCase().trim();
    const bySso = await this.users.findOne({
      where: { sso_provider: provider, sso_subject: subject },
    });
    if (bySso) {
      if (bySso.status !== 'active') {
        throw new UnauthorizedException('Admin account disabled');
      }
      return bySso;
    }
    // No open self-signup: only link SSO to a pre-seeded admin row by email.
    const byEmail = await this.users.findOne({
      where: { email: normalizedEmail },
    });
    if (!byEmail || byEmail.status !== 'active') {
      throw new UnauthorizedException('No admin account for this identity');
    }
    await this.users.update(
      { id: byEmail.id },
      {
        sso_provider: provider,
        sso_subject: subject,
        last_login_at: new Date(),
      },
    );
    return byEmail;
  }

  private async issueTokens(
    user: AdminUser,
    sessionId: string,
  ): Promise<{
    tokens: AdminSessionTokens;
    refreshTokenId: string;
  }> {
    const secret = resolveAdminSessionSecret(this.config);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret, expiresIn: ADMIN_ACCESS_TOKEN_SECONDS },
    );
    const rawRefreshToken = generateRefreshToken();
    const saved = await this.refreshTokens.save(
      this.refreshTokens.create({
        session_id: sessionId,
        token_hash: hashRefreshToken(rawRefreshToken),
        expires_at: new Date(Date.now() + ADMIN_REFRESH_TOKEN_SECONDS * 1000),
      }),
    );
    return {
      refreshTokenId: saved.id,
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        user: serializeAdminUser(user),
        expiresIn: ADMIN_ACCESS_TOKEN_SECONDS,
      },
    };
  }

  private async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.sessions.update(
      { id: sessionId, revoked_at: undefined },
      { revoked_at: now },
    );
    await this.refreshTokens.update(
      { session_id: sessionId, revoked_at: undefined },
      { revoked_at: now },
    );
  }
}
