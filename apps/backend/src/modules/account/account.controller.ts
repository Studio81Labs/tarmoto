import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { ExceptionFilter, RawBodyRequest } from '@nestjs/common';
import type { Response } from 'express';
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
import { IapValidateService } from './iap-validate.service.js';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto.js';
import { CreatePortalSessionDto } from './dto/create-portal-session.dto.js';
import { DeleteAccountDto } from './dto/delete-account.dto.js';
import { DeleteAccountResponseDto } from './dto/delete-account-response.dto.js';
import {
  IapValidateErrorResponseDto,
  IapValidateRequestDto,
  IapValidateResponseDto,
} from './dto/iap-validate.dto.js';
import {
  RedirectUrlResponseDto,
  SubscriptionSnapshotResponseDto,
} from './dto/subscription-response.dto.js';

/**
 * Endpoint-scoped filter for `POST /account/subscription/iap/validate` that
 * normalises DTO-validation 400s to the `{ message, retryable }` contract the
 * endpoint advertises via `@ApiResponse({ status: 400, type:
 * IapValidateErrorResponseDto })`.
 *
 * The GLOBAL `ValidationPipe` (see `main.ts`) validates the body and, on
 * failure, throws its default `BadRequestException` shaped
 * `{ statusCode, message: string|string[], error }` — with `message` often an
 * ARRAY. A generated mobile client can't apply the documented retry/finish
 * decision for that shape. A route-scoped `@Body` ValidationPipe cannot fix this
 * because Nest runs global pipes BEFORE param pipes (`pipes.concat(paramPipes)`
 * in `router-execution-context`), so the global pipe throws first and a param
 * pipe's `exceptionFactory` never runs. Reshaping without touching the global
 * pipe therefore has to happen AFTER the pipe throws — this handler-scoped
 * filter catches that `BadRequestException` and rewrites it. The global pipe
 * still owns the validation RULES (whitelist / forbidNonWhitelisted /
 * transform); only the error SHAPE changes here.
 *
 * The service itself throws `BadRequestException({ message, retryable })` for
 * genuine terminal validation failures — those already satisfy the contract, so
 * they are passed through unchanged (detected by the presence of `retryable`).
 * A DTO-validation failure is never retryable (the same body always fails), so
 * the reshaped body carries `retryable: false`.
 */
@Catch(BadRequestException)
export class IapValidateBadRequestFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse();

    // Already the advertised contract (thrown by the service) — pass through.
    if (typeof body === 'object' && body !== null && 'retryable' in body) {
      res.status(exception.getStatus()).json(body);
      return;
    }

    // Otherwise this is the global ValidationPipe's default rejection. Collapse
    // its `message` (string | string[]) to a single string and add `retryable`.
    const raw = (body as { message?: unknown }).message;
    const message = Array.isArray(raw)
      ? raw.join('; ')
      : typeof raw === 'string' && raw.length > 0
        ? raw
        : 'Invalid request body.';
    res.status(HttpStatus.BAD_REQUEST).json({ message, retryable: false });
  }
}

@ApiTags('account')
@Controller('account')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountDeletionService: AccountDeletionService,
    private readonly iapValidateService: IapValidateService,
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

  @Post('subscription/iap/validate')
  @UseGuards(AuthGuard)
  @UseFilters(IapValidateBadRequestFilter)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Validate a native in-app subscription purchase (Apple StoreKit2)',
    description:
      'Verifies the StoreKit2 signed transaction server-side, binds it to the ' +
      'authenticated rider, derives the tier from the verified product, claims ' +
      'the rider subscription slot, and returns the subscription snapshot.',
  })
  @ApiBody({ type: IapValidateRequestDto })
  @ApiResponse({ status: 201, type: IapValidateResponseDto })
  @ApiResponse({
    status: 400,
    type: IapValidateErrorResponseDto,
    description:
      'Invalid/forged transaction, an unrecognized authoritative product ' +
      '(not in the catalog), or the subscription is no longer active',
  })
  @ApiResponse({
    status: 409,
    type: IapValidateErrorResponseDto,
    description:
      'Purchase not linked to this account, trial already used, or another ' +
      'provider already owns the subscription slot',
  })
  @ApiResponse({
    status: 503,
    type: IapValidateErrorResponseDto,
    description: 'The App Store is temporarily unavailable (retryable)',
  })
  async validateIap(
    @Req() req: Request,
    @Body() dto: IapValidateRequestDto,
  ): Promise<IapValidateResponseDto> {
    return this.iapValidateService.validate(req.user!.userId, dto);
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
