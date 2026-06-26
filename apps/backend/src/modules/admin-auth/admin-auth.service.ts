import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AdminUser, type AdminRole } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import {
  ADMIN_ACCESS_TOKEN_SCOPE,
  ADMIN_ACCESS_TOKEN_SECONDS,
  ADMIN_REFRESH_TOKEN_SECONDS,
  REFRESH_REUSE_LEEWAY_MS,
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revoked_at) {
      // Token was previously revoked. Distinguish a benign concurrent rotation
      // from genuine token reuse (theft or replay).
      const nowMs = Date.now();
      const revokedRecently =
        nowMs - stored.revoked_at.getTime() <= REFRESH_REUSE_LEEWAY_MS;
      if (stored.replaced_by_token_id != null && revokedRecently) {
        // Benign concurrent rotation: a winning tab already rotated this token
        // within the leeway window. The new token is already in the shared
        // cookie jar — do NOT revoke the session family.
        throw new UnauthorizedException('Invalid refresh token');
      }
      // Genuine reuse: token was explicitly revoked (logout / admin action) or
      // was replayed after the leeway expired. Revoke the whole session chain.
      await this.revokeSession(stored.session_id);
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.expires_at <= new Date()) {
      // Plain token expiry — normal lifetime end, not an attack.
      // Do NOT revoke the session family; the admin simply needs to log in again.
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

    // Atomically claim the old token first (conditional on revoked_at IS NULL).
    // This serializes concurrent refresh requests: the first writer sets revoked_at
    // and its UPDATE matches 1 row; the second's UPDATE matches 0 rows and is
    // detected as reuse, triggering full session-family revocation.
    type TxnOutcome =
      | { reuse: true }
      | { reuse: false; tokens: AdminSessionTokens };

    const outcome = await this.dataSource.transaction<TxnOutcome>(
      async (manager) => {
        const refreshRepo = manager.getRepository(AdminRefreshToken);
        const sessionRepo = manager.getRepository(AdminSession);
        const now = new Date();

        // Step 1: Claim — conditional update gated on revoked_at IS NULL.
        const claim = await refreshRepo.update(
          { id: stored.id, revoked_at: IsNull() },
          { revoked_at: now, last_used_at: now },
        );

        if (claim.affected !== 1) {
          // Loser of a benign concurrent rotation: the winning tab claimed the
          // token microseconds before us. The pre-transaction guard already
          // passed (token was not revoked at read time), so this is a benign
          // race — not a genuine replay. The winner's new token is already in
          // the shared cookie jar; do NOT revoke the session family.
          return { reuse: true as const };
        }

        // Step 2: Mint the replacement token.
        const result = await this.issueTokens(user, session.id, manager);

        // Step 3: Link old token to its replacement.
        await refreshRepo.update(
          { id: stored.id },
          { replaced_by_token_id: result.refreshTokenId },
        );

        // Step 4: Bump session activity.
        await sessionRepo.update({ id: session.id }, { last_seen_at: now });

        return { reuse: false as const, tokens: result.tokens };
      },
    );

    if (outcome.reuse) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return outcome.tokens;
  }

  async revoke(
    rawRefreshToken: string,
  ): Promise<{ admin_user_id: string; admin_role: AdminRole } | null> {
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: hashRefreshToken(rawRefreshToken) },
    });
    if (!stored) return null;

    const session = await this.sessions.findOne({
      where: { id: stored.session_id },
    });

    await this.revokeSession(stored.session_id);

    if (!session) return null;

    const user = await this.users.findOne({
      where: { id: session.admin_user_id },
    });
    if (!user) return null;

    return { admin_user_id: session.admin_user_id, admin_role: user.role };
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
    // Guard against SSO identity hijack: if this admin row is already linked to
    // a DIFFERENT SSO identity (the first bySso lookup did not match, so the
    // subjects differ), refuse to overwrite the existing link. A new GitHub
    // account presenting the same verified email must not silently take over
    // an existing linked account.
    if (byEmail.sso_subject !== null) {
      throw new UnauthorizedException(
        'Admin account is linked to a different SSO identity',
      );
    }
    // First-time SSO link: the admin row has no prior identity — safe to link.
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
    manager?: EntityManager,
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
    const repo = manager
      ? manager.getRepository(AdminRefreshToken)
      : this.refreshTokens;
    const saved = await repo.save(
      repo.create({
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
      { id: sessionId, revoked_at: IsNull() },
      { revoked_at: now },
    );
    await this.refreshTokens.update(
      { session_id: sessionId, revoked_at: IsNull() },
      { revoked_at: now },
    );
  }
}
