import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { EmailModule } from '../email/index.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  STRIPE_BILLING_CLIENT,
  StripeNodeBillingClient,
} from './stripe-billing.client.js';
import { DataExportModule } from './data-export/data-export.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([User]), EmailModule, DataExportModule],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountDeletionService,
    StripeNodeBillingClient,
    {
      provide: STRIPE_BILLING_CLIENT,
      useExisting: StripeNodeBillingClient,
    },
  ],
  exports: [AccountDeletionService],
})
export class AccountModule {}
