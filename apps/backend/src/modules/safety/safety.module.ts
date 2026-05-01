import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { CrashAlert } from '../../entities/crash-alert.entity.js';
import { EventsModule } from '../events/index.js';
import { PushModule } from '../push/index.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';
import { CRASH_ALERT_NOTIFIER } from './crash-alert-notifier.interface.js';
import { TwilioCrashAlertNotifier } from './providers/twilio-notifier.provider.js';

/**
 * Safety module — wires the crash-alert pipeline.
 *
 * Swap the SMS/voice provider by replacing `CRASH_ALERT_NOTIFIER`
 * with a different `useClass`. Implementations live under
 * `./providers/`.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([User, UserContact, CrashAlert]),
    EventsModule,
    PushModule,
  ],
  controllers: [SafetyController],
  providers: [
    { provide: CRASH_ALERT_NOTIFIER, useClass: TwilioCrashAlertNotifier },
    SafetyService,
  ],
  exports: [SafetyService],
})
export class SafetyModule {}
