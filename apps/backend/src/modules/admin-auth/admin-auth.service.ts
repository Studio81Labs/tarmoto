import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
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
  clientNonce: string;
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

    const clientNonce = randomBytes(16).toString('hex');
    const now = Date.now();
    const session = await this.sessions.save(
      this.sessions.create({
        admin_user_id: user.id,
        expires_at: new Date(now + ADMIN_REFRESH_TOKEN_SECONDS * 1000),
        last_seen_at: new Date(now),
        client_nonce: clientNonce,
      }),
    );
    return (await this.issueTokens(user, session.id, clientNonce)).tokens;
  }

  async refresh(
    rawRefreshToken: string,
    presentedClientNonce?: string | null,
  ): Promise<AdminSessionTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: tokenHash },
    });
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revoked_at) {
      // Token was previously consumed. Use the client nonce to distinguish a
      // benign sibling-tab replay (same browser jar) from genuine token reuse
      // (theft or replay from a foreign jar).
      const session = await this.sessions.findOne({
        where: { id: stored.session_id },
      });
      if (
        presentedClientNonce &&
        session?.client_nonce &&
        presentedClientNonce === session.client_nonce
      ) {
        // BENIGN: same browser jar — the winning tab already rotated this
        // token. Do NOT revoke the session family.
        throw new UnauthorizedException('Invalid refresh token');
      }
      // GENUINE REUSE: different jar, missing nonce, or no nonce on record.
      // Revoke the whole session family to contain potential theft.
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
    // detected as reuse, triggering the jar-based check below.
    type TxnOutcome =
      | { reuse: true; revoke: boolean }
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
          // Claim-loser of a concurrent rotation. Apply the same jar-based
          // check: if the presented nonce matches the session's stored nonce
          // it's the same browser jar (benign sibling tab) — do not revoke;
          // otherwise treat as genuine reuse and revoke the session family.
          const isbenign =
            !!presentedClientNonce &&
            !!session.client_nonce &&
            presentedClientNonce === session.client_nonce;
          return { reuse: true as const, revoke: !isbenign };
        }

        // Step 2: Mint the replacement token.
        const result = await this.issueTokens(
          user,
          session.id,
          session.client_nonce ?? '',
          manager,
        );

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
      if (outcome.revoke) {
        await this.revokeSession(stored.session_id);
      }
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
    clientNonce: string,
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
        clientNonce,
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
