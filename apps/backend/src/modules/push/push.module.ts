import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceToken } from '../../entities/device-token.entity.js';
import { NotificationPreferencesRow } from '../../entities/notification-preferences.entity.js';
import { AuthModule } from '../auth/index.js';
import { DevicesController } from './devices.controller.js';
import { DeviceTokensService } from './device-tokens.service.js';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import {
  ApnPushProvider,
  type ApnProviderConfig,
} from './providers/apn.provider.js';
import { CompositePushProvider } from './providers/composite.provider.js';
import {
  FcmPushProvider,
  type FcmProviderConfig,
} from './providers/fcm.provider.js';
import { LogPushProvider } from './providers/log.provider.js';
import { PUSH_PROVIDER, type PushProvider } from './push-provider.js';
import { PushService } from './push.service.js';

const BOOTSTRAP_LOGGER = new Logger('PushModule');

const pushProviderFactory = (config: ConfigService): PushProvider => {
  const fallback = new LogPushProvider();
  const fcm = buildFcmProvider(config);
  const apn = buildApnProvider(config);

  if (!fcm && !apn) {
    BOOTSTRAP_LOGGER.log(
      'Push provider: log (no FCM or APN credentials configured) — push payloads will only appear in application logs.',
    );
    return fallback;
  }

  if (fcm) {
    BOOTSTRAP_LOGGER.log(
      'Push provider: FCM enabled — serves Android natively and iOS via APN handoff',
    );
  }
  if (apn) {
    BOOTSTRAP_LOGGER.log(
      'Push provider: APN enabled (used for iOS only when FCM is not configured)',
    );
  }

  return new CompositePushProvider({
    fcm,
    apn,
    fallback,
  });
};

function buildFcmProvider(config: ConfigService): PushProvider | null {
  const projectId = config.get<string>('TARMOTO_FCM_PROJECT_ID')?.trim();
  const clientEmail = config.get<string>('TARMOTO_FCM_CLIENT_EMAIL')?.trim();
  const privateKey = config.get<string>('TARMOTO_FCM_PRIVATE_KEY');
  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }
  // The .env path stores the PEM with literal `\n` separators so it
  // survives a single-line shell variable. Normalise back to real
  // newlines before handing to firebase-admin.
  const normalisedKey = privateKey.replace(/\\n/g, '\n');
  const cfg: FcmProviderConfig = {
    projectId,
    clientEmail,
    privateKey: normalisedKey,
  };
  try {
    return new FcmPushProvider(cfg);
  } catch (err) {
    BOOTSTRAP_LOGGER.warn(
      `Failed to initialise FCM provider, falling back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function buildApnProvider(config: ConfigService): PushProvider | null {
  const key = config.get<string>('TARMOTO_APN_KEY');
  const keyId = config.get<string>('TARMOTO_APN_KEY_ID')?.trim();
  const teamId = config.get<string>('TARMOTO_APN_TEAM_ID')?.trim();
  const topic = config.get<string>('TARMOTO_APN_TOPIC')?.trim();
  if (!key || !keyId || !teamId || !topic) {
    return null;
  }
  const production =
    config.get<string>('TARMOTO_APN_PRODUCTION')?.trim().toLowerCase() ===
    'true';
  const cfg: ApnProviderConfig = {
    key: key.replace(/\\n/g, '\n'),
    keyId,
    teamId,
    topic,
    production,
  };
  try {
    return new ApnPushProvider(cfg);
  } catch (err) {
    BOOTSTRAP_LOGGER.warn(
      `Failed to initialise APN provider, falling back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

const pushProvider: Provider = {
  provide: PUSH_PROVIDER,
  inject: [ConfigService],
  useFactory: pushProviderFactory,
};

/**
 * Closes the APN HTTP/2 connection pool when Nest shuts down. We
 * register this as a separate provider rather than baking lifecycle
 * into `ApnPushProvider` itself because the provider is wrapped in
 * `CompositePushProvider` and isn't directly injectable.
 */
@Injectable()
class PushProviderShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(PUSH_PROVIDER) private readonly provider: PushProvider) {}

  onApplicationShutdown(): void {
    walkAndShutdown(this.provider);
  }
}

function walkAndShutdown(provider: PushProvider): void {
  if (provider instanceof CompositePushProvider) {
    const opts = (
      provider as unknown as {
        options: { fcm: PushProvider | null; apn: PushProvider | null };
      }
    ).options;
    if (opts.fcm) walkAndShutdown(opts.fcm);
    if (opts.apn) walkAndShutdown(opts.apn);
  }
  if (provider instanceof ApnPushProvider) {
    provider.shutdown();
  }
}

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    TypeOrmModule.forFeature([DeviceToken, NotificationPreferencesRow]),
  ],
  controllers: [DevicesController, NotificationPreferencesController],
  providers: [
    pushProvider,
    PushService,
    DeviceTokensService,
    NotificationPreferencesService,
    PushProviderShutdownHook,
  ],
  exports: [PushService, DeviceTokensService, NotificationPreferencesService],
})
export class PushModule {}

export { pushProviderFactory };
