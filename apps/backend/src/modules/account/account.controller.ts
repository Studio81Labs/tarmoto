import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { PurchaseIdentityResponseDto } from './dto/purchase-identity-response.dto.js';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto.js';
import { CreatePortalSessionDto } from './dto/create-portal-session.dto.js';
import {
  VerifyCheckoutSessionDto,
  VerifyCheckoutSessionResponseDto,
} from './dto/verify-checkout-session.dto.js';
import { DeleteAccountDto } from './dto/delete-account.dto.js';
import { DeleteAccountResponseDto } from './dto/delete-account-response.dto.js';
import {
  RedirectUrlResponseDto,
  SubscriptionSnapshotResponseDto,
} from './dto/subscription-response.dto.js';

@ApiTags('account')
@Controller('account')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Get('subscription')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Load the current account subscription snapshot' })
  @ApiResponse({ status: 200, type: SubscriptionSnapshotResponseDto })
  async getSubscription(
    @Req() req: Request,
  ): Promise<SubscriptionSnapshotResponseDto> {
    return this.accountService.getSubscription(req.user!.userId);
  }

  /**
   * The opaque token the client hands to the purchase SDK. Authenticated, and
   * scoped to the caller's OWN account — never another rider's, and never
   * exposed on a public profile. See open item (j) in
   * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
   */
  @Get('subscription/purchase-identity')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Load the caller's opaque purchase-account token (minted on first use)",
  })
  @ApiResponse({ status: 200, type: PurchaseIdentityResponseDto })
  async getPurchaseIdentity(
    @Req() req: Request,
  ): Promise<PurchaseIdentityResponseDto> {
    return this.accountService.getPurchaseIdentity(req.user!.userId);
  }

  @Post('subscription/checkout')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a Stripe Checkout session for a paid plan' })
  @ApiBody({ type: CreateCheckoutSessionDto })
  @ApiResponse({ status: 201, type: RedirectUrlResponseDto })
  async createCheckoutSession(
    @Req() req: Request,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    return this.accountService.createCheckoutSession(req.user!.userId, dto);
  }

  @Post('subscription/checkout/verify')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Verify a completed Checkout session belongs to the caller',
    description:
      'Reads the session back from Stripe and confirms it completed AND belongs to the authenticated rider, so the client can state that a trial started without trusting a URL parameter. Every negative — unknown id, unfinished checkout, another rider\u2019s session — answers `completed: false`.',
  })
  @ApiBody({ type: VerifyCheckoutSessionDto })
  @ApiResponse({ status: 201, type: VerifyCheckoutSessionResponseDto })
  async verifyCheckoutSession(
    @Req() req: Request,
    @Body() dto: VerifyCheckoutSessionDto,
  ): Promise<VerifyCheckoutSessionResponseDto> {
    return this.accountService.verifyCheckoutSession(req.user!.userId, dto);
  }

  @Post('subscription/portal')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a Stripe Customer Portal session' })
  @ApiBody({ type: CreatePortalSessionDto })
  @ApiResponse({ status: 201, type: RedirectUrlResponseDto })
  async createPortalSession(
    @Req() req: Request,
    @Body() dto: CreatePortalSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    return this.accountService.createPortalSession(req.user!.userId, dto);
  }

  @Post('subscription/webhook')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive Stripe Billing webhook events' })
  @ApiResponse({ status: 200 })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!signature) {
      throw new UnauthorizedException('Missing Stripe signature header');
    }
    if (!req.rawBody) {
      throw new UnauthorizedException('Missing raw request body');
    }

    await this.accountService.handleWebhook(req.rawBody, signature);
    return { received: true };
  }

  @Delete()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Schedule the authenticated account for permanent deletion (GDPR Art. 17)',
    description:
      'Soft-deletes immediately and schedules a hard delete after a 30-day grace period. ' +
      'Requires the current password as fresh-auth proof. Cancels Stripe billing as part of the purge. ' +
      'Anonymized road-quality contributions are retained per the deletion notice.',
  })
  @ApiBody({ type: DeleteAccountDto })
  @ApiResponse({ status: 200, type: DeleteAccountResponseDto })
  @ApiResponse({
    status: 403,
    description:
      'Password does not match, or the account is already pending deletion',
  })
  async deleteAccount(
    @Req() req: Request,
    @Body() dto: DeleteAccountDto,
  ): Promise<DeleteAccountResponseDto> {
    return this.accountDeletionService.requestDeletion(req.user!.userId, dto);
  }
}
