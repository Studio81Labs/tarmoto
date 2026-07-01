import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { AdminAuthService, serializeAdminUser } from './admin-auth.service.js';
import {
  AdminAuthConfigDto,
  AdminAuthSessionResponseDto,
  AdminLoginDto,
  AdminMeResponseDto,
} from './dto/admin-auth.dto.js';
import {
  ADMIN_CLIENT_COOKIE,
  ADMIN_REFRESH_COOKIE,
  ADMIN_SSO_STATE_COOKIE,
} from './admin-auth.constants.js';
import {
  clearAdminAuthCookies,
  clearAdminClientCookie,
  clearAdminSsoStateCookie,
  readCookie,
  setAdminAuthCookies,
  setAdminClientCookie,
  setAdminSsoStateCookie,
} from './admin-auth.cookies.js';
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
} from './admin-github-sso.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { isAdminPasswordLoginEnabled } from './admin-password-login.js';
import { setAdminAuditActor } from '../admin/admin-audit-context.js';
import { AdminAuditService } from '../admin/admin-audit.interceptor.js';

const SSO_ERROR_REDIRECT = '/?adminAuthError=sso';

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly service: AdminAuthService,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  private get secure(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  @Get('config')
  @ApiOperation({ summary: 'Public admin auth config (pre-auth)' })
  @ApiResponse({ status: 200, type: AdminAuthConfigDto })
  getConfig(): AdminAuthConfigDto {
    return { passwordLoginEnabled: isAdminPasswordLoginEnabled(this.config) };
  }

  @Post('login')
  @ApiOperation({ summary: 'Admin password login (dev / fallback)' })
  @ApiResponse({ status: 201, type: AdminAuthSessionResponseDto })
  async login(
    @Body() dto: AdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminAuthSessionResponseDto> {
    try {
      if (!isAdminPasswordLoginEnabled(this.config)) {
        throw new ForbiddenException('Password login is disabled');
      }
      const tokens = await this.service.loginWithPassword(
        dto.email,
        dto.password,
      );
      setAdminAuditActor(req, {
        admin_user_id: tokens.user.id,
        admin_role: tokens.user.role,
      });
      setAdminAuthCookies(
        res,
        tokens.accessToken,
        tokens.refreshToken,
        this.secure,
      );
      setAdminClientCookie(res, tokens.clientNonce, this.secure);
      return { user: tokens.user, expiresIn: tokens.expiresIn };
    } catch (error) {
      // Record a denied audit row for any login failure (disabled password
      // login or invalid credentials). record() is best-effort and never throws.
      void this.audit.record({
        event_key: 'admin.auth.login',
        outcome: 'denied',
        method: 'POST',
        path: '/admin/auth/login',
        admin_user_id: null,
        admin_role: null,
        target_type: null,
        target_id: null,
        metadata: {
          email: dto.email,
          reason:
            error instanceof ForbiddenException
              ? 'password_login_disabled'
              : 'invalid_credentials',
        },
      });
      throw error;
    }
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the admin session tokens' })
  @ApiResponse({ status: 201, type: AdminAuthSessionResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminAuthSessionResponseDto> {
    const raw = readCookie(req, ADMIN_REFRESH_COOKIE);
    if (!raw) throw new UnauthorizedException('Missing refresh token');
    const clientNonce = readCookie(req, ADMIN_CLIENT_COOKIE);
    const tokens = await this.service.refresh(raw, clientNonce);
    setAdminAuditActor(req, {
      admin_user_id: tokens.user.id,
      admin_role: tokens.user.role,
    });
    setAdminAuthCookies(
      res,
      tokens.accessToken,
      tokens.refreshToken,
      this.secure,
    );
    setAdminClientCookie(res, tokens.clientNonce, this.secure);
    return { user: tokens.user, expiresIn: tokens.expiresIn };
  }

  @Get('me')
  @ApiOperation({ summary: 'Current admin session' })
  @ApiResponse({ status: 200, type: AdminMeResponseDto })
  me(@Req() req: Request): AdminMeResponseDto {
    const adminUser = (req as AdminRequest).adminUser;
    if (!adminUser) throw new UnauthorizedException();
    return { user: serializeAdminUser(adminUser) };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the admin session' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw = readCookie(req, ADMIN_REFRESH_COOKIE);
    if (raw) {
      const actor = await this.service.revoke(raw);
      if (actor) {
        setAdminAuditActor(req, {
          admin_user_id: actor.admin_user_id,
          admin_role: actor.admin_role,
        });
      }
    }
    clearAdminAuthCookies(res, this.secure);
    clearAdminClientCookie(res, this.secure);
  }

  @Get('sso/github/start')
  @ApiOperation({ summary: 'Begin GitHub OAuth' })
  start(@Res() res: Response): void {
    const state = randomBytes(16).toString('hex');
    setAdminSsoStateCookie(res, state, this.secure);
    res.redirect(buildGithubAuthorizeUrl(state, this.config));
  }

  @Get('sso/github/callback')
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const callbackPath = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    try {
      const expectedState = readCookie(req, ADMIN_SSO_STATE_COOKIE);
      clearAdminSsoStateCookie(res, this.secure);
      if (!code || !state || !expectedState || state !== expectedState) {
        void this.audit.record({
          event_key: 'admin.auth.sso_login',
          outcome: 'denied',
          method: 'GET',
          path: callbackPath,
          admin_user_id: null,
          admin_role: null,
          target_type: null,
          target_id: null,
          metadata: { provider: 'github', reason: 'state_mismatch' },
        });
        res.redirect(SSO_ERROR_REDIRECT);
        return;
      }
      const { subject, emails } = await exchangeGithubCode(code, this.config);
      const user = await this.service.findOrProvisionSsoUser(
        'github',
        subject,
        emails,
      );
      const tokens = await this.service.createSession(user.id);
      setAdminAuthCookies(
        res,
        tokens.accessToken,
        tokens.refreshToken,
        this.secure,
      );
      setAdminClientCookie(res, tokens.clientNonce, this.secure);
      // The audit interceptor skips GET requests, so record the SSO login
      // explicitly. record() is best-effort and never throws.
      void this.audit.record({
        event_key: 'admin.auth.sso_login',
        outcome: 'allowed',
        method: 'GET',
        path: callbackPath,
        admin_user_id: user.id,
        admin_role: user.role,
        target_type: null,
        target_id: null,
        metadata: { provider: 'github' },
      });
      res.redirect('/');
    } catch (error) {
      void this.audit.record({
        event_key: 'admin.auth.sso_login',
        outcome: 'denied',
        method: 'GET',
        path: callbackPath,
        admin_user_id: null,
        admin_role: null,
        target_type: null,
        target_id: null,
        metadata: {
          provider: 'github',
          reason: 'callback_failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      });
      res.redirect(SSO_ERROR_REDIRECT);
    }
  }
}
