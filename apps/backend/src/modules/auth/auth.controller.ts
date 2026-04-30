import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { AuthResponseDto } from './dto/auth-response.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly emailVerification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Register a new account' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refresh_token);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Consume an email-verification token' })
  @ApiResponse({ status: 200, schema: { example: { verified: true } } })
  @ApiResponse({
    status: 400,
    description: 'Token is invalid, consumed, or expired',
  })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ verified: true }> {
    return this.emailVerification.verify(dto.token);
  }

  @Post('resend-verification')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({
    summary: 'Resend the verification email to the current user',
  })
  @ApiResponse({ status: 204 })
  async resendVerification(@Req() req: Request): Promise<void> {
    await this.emailVerification.resend(req.user!.userId);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Request a password-reset email',
    description:
      'Always returns 204 to prevent email-enumeration via response codes. ' +
      'A reset email is only sent if the address is registered.',
  })
  @ApiResponse({ status: 204 })
  forgotPassword(@Req() req: Request, @Body() dto: ForgotPasswordDto): void {
    // Fire-and-forget: a known address triggers a DB lookup, token
    // invalidate + insert, and an HTTP send to Resend, while an
    // unknown address falls out at the first findOne. Awaiting that
    // would surface the difference as response latency — easily
    // measurable from the outside even though the status code is
    // identical for both. Not awaiting makes the HTTP timing constant
    // (sub-ms regardless of the email) while the actual work still
    // runs server-side. The service catches its own errors so this
    // can never throw an unhandled rejection.
    void this.passwordReset.requestReset(dto.email, req.ip ?? null);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Consume a password-reset token + set a new password',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 400,
    description: 'Reset link is invalid, consumed, or expired',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.passwordReset.consumeReset(dto.token, dto.password);
  }
}
