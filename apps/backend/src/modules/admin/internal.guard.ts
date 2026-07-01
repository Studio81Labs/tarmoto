import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminUser, type AdminRole } from '../../entities/admin-user.entity.js';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_ACCESS_TOKEN_SCOPE,
  API_GLOBAL_PREFIX,
} from '../admin-auth/admin-auth.constants.js';
import type { AdminAccessTokenPayload } from '../admin-auth/admin-access-token-payload.js';
import { ADMIN_ROLES_KEY } from '../admin-auth/admin-role.decorator.js';
import { hasRequiredAdminRole } from '../admin-auth/admin-role-rank.js';
import { resolveAdminSessionSecret } from '../admin-auth/admin-session-secret.js';
import { readCookie } from '../admin-auth/admin-auth.cookies.js';
import { AdminAuditService } from './admin-audit.interceptor.js';

export interface AdminRequest extends Request {
  adminUser?: AdminUser;
}

// Header the admin proxy (Cloudflare Worker) injects to prove a request
// transited the trusted proxy rather than hitting the admin API directly.
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

// Length-guarded constant-time compare — timingSafeEqual throws on a length
// mismatch, and the provided token is attacker-controlled.
function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Keys are always in bare /admin/... form; normalizePath() strips the global
// prefix before comparison so both bare and prefixed requests match.
const PUBLIC_ADMIN_AUTH_PATHS = new Set([
  'GET /admin/auth/config',
  'POST /admin/auth/login',
  'POST /admin/auth/refresh',
  'POST /admin/auth/logout',
  'GET /admin/auth/sso/github/start',
  'GET /admin/auth/sso/github/callback',
]);

@Injectable()
export class InternalGuard implements CanActivate {
  private readonly logger = new Logger('InternalGuard');

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @InjectRepository(AdminSession)
    private readonly sessions: Repository<AdminSession>,
    private readonly audit: AdminAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    // Security decision: use the normalized (prefix-stripped) path so that
    // routes served under /api/v1/admin/... are treated identically to bare
    // /admin/... paths (e.g. in tests where setGlobalPrefix is not applied).
    const normalized = this.normalizePath(request);
    if (!normalized.startsWith('/admin/')) return true;

    // Outer gate for the whole admin API (incl. public auth paths): when an
    // internal token is configured, every admin request must carry the header
    // the admin proxy injects. Runs before the public-path bypass so login /
    // SSO are reachable only through the proxy too.
    this.assertInternalToken(request);

    if (this.isPublicAdminAuthPath(normalized, request)) return true;

    await this.authenticate(request);
    this.assertRole(context, request);
    return true;
  }

  private assertInternalToken(request: AdminRequest): void {
    const expected = this.config
      .get<string>('TARMOTO_INTERNAL_API_TOKEN')
      ?.trim();

    if (!expected) {
      // Fail closed in production: the admin API must only be reachable
      // through the trusted admin proxy (which injects the token), never
      // served ungated because the secret was forgotten. In dev/test the gate
      // is off so the Vite dev proxy reaches the API with just the session
      // cookie. Mirrors resolveAdminSessionSecret's prod-only requirement.
      if (this.config.get<string>('NODE_ENV') === 'production') {
        this.deny(request, 'internal_token_not_configured');
        throw new UnauthorizedException('Internal admin API not configured');
      }
      return;
    }

    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!provided) {
      this.deny(request, 'missing_internal_token');
      throw new UnauthorizedException('Invalid internal token');
    }
    if (!tokensEqual(provided, expected)) {
      this.deny(request, 'invalid_internal_token');
      throw new UnauthorizedException('Invalid internal token');
    }
  }

  private async authenticate(request: AdminRequest): Promise<void> {
    const token = this.readAccessToken(request);
    if (!token) {
      this.deny(request, 'missing_session');
      throw new UnauthorizedException('Admin session required');
    }
    let payload: AdminAccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminAccessTokenPayload>(token, {
        secret: resolveAdminSessionSecret(this.config),
      });
    } catch {
      this.deny(request, 'invalid_session');
      throw new UnauthorizedException('Admin session required');
    }
    if (payload.scope !== ADMIN_ACCESS_TOKEN_SCOPE || !payload.sid) {
      this.deny(request, 'invalid_session');
      throw new UnauthorizedException('Admin session required');
    }

    const now = new Date();
    const session = await this.sessions.findOne({
      where: { id: payload.sid, admin_user_id: payload.sub },
    });
    const adminUser = await this.loadSessionUser(session, payload.sub);
    if (
      !session ||
      session.revoked_at ||
      session.expires_at <= now ||
      !adminUser ||
      adminUser.status !== 'active'
    ) {
      this.deny(request, 'invalid_session');
      throw new UnauthorizedException('Admin session required');
    }
    request.adminUser = adminUser;
    await this.sessions.update({ id: session.id }, { last_seen_at: now });
  }

  // AdminSession has no ORM relation to AdminUser (kept as a plain FK column),
  // so resolve the user explicitly.
  private async loadSessionUser(
    session: AdminSession | null,
    adminUserId: string,
  ): Promise<AdminUser | null> {
    if (!session) return null;
    return this.sessions.manager.findOne(AdminUser, {
      where: { id: adminUserId },
    });
  }

  private assertRole(context: ExecutionContext, request: AdminRequest): void {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) return;
    const role = request.adminUser?.role;
    if (role && hasRequiredAdminRole(role, requiredRoles)) return;
    this.deny(request, 'insufficient_role');
    throw new ForbiddenException('Admin role not allowed');
  }

  private readAccessToken(request: AdminRequest): string | null {
    const cookie = readCookie(request, ADMIN_ACCESS_COOKIE);
    if (cookie) return cookie;
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
    return null;
  }

  private deny(request: AdminRequest, reason: string): void {
    const rawPath = this.path(request);
    this.logger.warn(
      JSON.stringify({
        event: 'admin.auth.denied',
        reason,
        path: rawPath,
      }),
    );
    void this.audit.record({
      event_key: 'admin.auth.denied',
      outcome: 'denied',
      method: request.method ?? 'UNKNOWN',
      path: rawPath,
      admin_user_id: request.adminUser?.id ?? null,
      admin_role: request.adminUser?.role ?? null,
      metadata: { reason },
    });
  }

  // Returns the raw request path (may include the global prefix in production).
  private path(request: AdminRequest): string {
    return (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
  }

  // Returns the path with the global prefix stripped so security checks work
  // consistently regardless of whether setGlobalPrefix is applied (e.g. tests
  // do not apply it, production does).
  private normalizePath(request: AdminRequest): string {
    const raw = this.path(request);
    return raw.startsWith(API_GLOBAL_PREFIX)
      ? raw.slice(API_GLOBAL_PREFIX.length) || '/'
      : raw;
  }

  private isPublicAdminAuthPath(
    normalizedPath: string,
    request: AdminRequest,
  ): boolean {
    const key = `${request.method ?? 'GET'} ${normalizedPath}`;
    return PUBLIC_ADMIN_AUTH_PATHS.has(key);
  }
}
