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
  ADMIN_REFRESH_COOKIE,
  ADMIN_SSO_STATE_COOKIE,
} from './admin-auth.constants.js';
import {
  clearAdminAuthCookies,
  clearAdminSsoStateCookie,
  readCookie,
  setAdminAuthCookies,
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
    return { user: tokens.user, expiresIn: tokens.expiresIn };
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
    const tokens = await this.service.refresh(raw);
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
    try {
      const expectedState = readCookie(req, ADMIN_SSO_STATE_COOKIE);
      clearAdminSsoStateCookie(res, this.secure);
      if (!code || !state || !expectedState || state !== expectedState) {
        res.redirect(SSO_ERROR_REDIRECT);
        return;
      }
      const { subject, email } = await exchangeGithubCode(code, this.config);
      const user = await this.service.findOrProvisionSsoUser(
        'github',
        subject,
        email,
      );
      const tokens = await this.service.createSession(user.id);
      setAdminAuthCookies(
        res,
        tokens.accessToken,
        tokens.refreshToken,
        this.secure,
      );
      // The audit interceptor skips GET requests, so record the SSO login
      // explicitly. record() is best-effort and never throws.
      void this.audit.record({
        event_key: 'admin.auth.sso_login',
        outcome: 'allowed',
        method: 'GET',
        path: (req.originalUrl ?? req.url ?? '').split('?')[0],
        admin_user_id: user.id,
        admin_role: user.role,
        target_type: null,
        target_id: null,
        metadata: { provider: 'github' },
      });
      res.redirect('/');
    } catch {
      res.redirect(SSO_ERROR_REDIRECT);
    }
  }
}
