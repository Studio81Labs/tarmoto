import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { PrivacyPreferencesRow } from '../../entities/privacy-preferences.entity.js';
import { HazardPhotoUpload } from '../../entities/hazard-photo-upload.entity.js';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';
import { EmailModule } from '../email/index.js';
import { PushModule } from '../push/index.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { PrivacyPreferencesController } from './privacy-preferences.controller.js';
import { PrivacyPreferencesService } from './privacy-preferences.service.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import {
  STRIPE_BILLING_CLIENT,
  StripeNodeBillingClient,
} from './stripe-billing.client.js';
import { DataExportModule } from './data-export/data-export.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      PrivacyPreferencesRow,
      HazardPhotoUpload,
      StoreBillingReconciliation,
    ]),
    EmailModule,
    DataExportModule,
    PushModule,
  ],
  controllers: [AccountController, PrivacyPreferencesController],
  providers: [
    AccountService,
    AccountDeletionService,
    PrivacyPreferencesService,
    ProviderClaimService,
    StoreReconciliationService,
    StripeNodeBillingClient,
    {
      provide: STRIPE_BILLING_CLIENT,
      useExisting: StripeNodeBillingClient,
    },
  ],
  exports: [
    AccountDeletionService,
    PrivacyPreferencesService,
    ProviderClaimService,
    StoreReconciliationService,
    // Exported so the jobs module's reconciliation retry processor can
    // inject the Stripe client directly to re-attempt a failed cancel.
    STRIPE_BILLING_CLIENT,
  ],
})
export class AccountModule {}
