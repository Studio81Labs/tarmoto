import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import {
  STRIPE_BILLING_CLIENT,
  StripeNodeBillingClient,
} from './stripe-billing.client.js';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [AccountController],
  providers: [
    AccountService,
    StripeNodeBillingClient,
    {
      provide: STRIPE_BILLING_CLIENT,
      useExisting: StripeNodeBillingClient,
    },
  ],
})
export class AccountModule {}
