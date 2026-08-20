import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { SubscriptionNotificationService } from './subscription-notification.service.js';
import { User } from '../../entities/user.entity.js';
import { PrivacyPreferencesRow } from '../../entities/privacy-preferences.entity.js';
import { HazardPhotoUpload } from '../../entities/hazard-photo-upload.entity.js';
import { StoreBillingReconciliation } from '../../entities/store-billing-reconciliation.entity.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import { EmailModule } from '../email/index.js';
import { PushModule } from '../push/index.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { PrivacyPreferencesController } from './privacy-preferences.controller.js';
import { PrivacyPreferencesService } from './privacy-preferences.service.js';
import { ProviderClaimService } from './provider-claim.service.js';
import { StoreChainWriterService } from './store-chain-writer.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { SubscriptionMutationLockService } from './subscription-mutation-lock.service.js';
import {
  SUBSCRIPTION_LOCK_REDIS,
  SubscriptionLockRedisShutdownHook,
  createSubscriptionLockRedis,
} from './subscription-lock-redis.js';
import {
  STRIPE_BILLING_CLIENT,
  StripeNodeBillingClient,
} from './stripe-billing.client.js';
import { DataExportModule } from './data-export/data-export.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { BillingConfigCheck } from './billing-config.check.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      PrivacyPreferencesRow,
      HazardPhotoUpload,
      StoreBillingReconciliation,
      StoreSubscription,
    ]),
    EmailModule,
    // `sys_billing_checkout` operator kill switch (see AccountService).
    FeaturesModule,
    DataExportModule,
    PushModule,
    // Producer-side client for the subscription-notification queue: the
    // connection + workers come from JobsModule.forRoot() (imported once at the
    // app root). AccountService enqueues here; the queue's WORKER lives in the
    // jobs module.
    BullModule.registerQueue({ name: QUEUE_NAMES.SUBSCRIPTION_NOTIFY }),
  ],
  controllers: [AccountController, PrivacyPreferencesController],
  providers: [
    // Boot-time coherence check for the Stripe settings (see the class doc).
    BillingConfigCheck,
    AccountService,
    AccountDeletionService,
    PrivacyPreferencesService,
    ProviderClaimService,
    StoreChainWriterService,
    StoreReconciliationService,
    SubscriptionNotificationService,
    SubscriptionMutationLockService,
    {
      provide: SUBSCRIPTION_LOCK_REDIS,
      useFactory: createSubscriptionLockRedis,
      inject: [ConfigService],
    },
    SubscriptionLockRedisShutdownHook,
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
    // Exported so the jobs module's reconciliation processor can run the
    // expired-rollup recomputation and the provisional-overlap deadline sweep,
    // and so the step-5 RevenueCat consumer has the chain-claim seam.
    StoreChainWriterService,
    StoreReconciliationService,
    // Exported so the jobs module's subscription-notify processor can deliver
    // (fence-revalidated) the notifications AccountService enqueues.
    SubscriptionNotificationService,
    // Exported so the jobs module's reconciliation retry processor can
    // inject the Stripe client directly to re-attempt a failed cancel.
    STRIPE_BILLING_CLIENT,
  ],
})
export class AccountModule {}
