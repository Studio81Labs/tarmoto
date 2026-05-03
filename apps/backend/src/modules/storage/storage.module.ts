import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';
import { buildStorageConfig } from './storage.config.js';
import { OBJECT_STORAGE } from './storage.tokens.js';
import type { ObjectStorage } from './object-storage.interface.js';

const OBJECT_STORAGE_PROVIDER: Provider = {
  provide: OBJECT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ObjectStorage => {
    const built = buildStorageConfig(config);
    if (built.driver === 's3') {
      return new S3Storage(built);
    }
    return new LocalStorage(built.baseDir, built.publicPathPrefix);
  },
};

/**
 * Provides the shared `ObjectStorage` instance under the
 * `OBJECT_STORAGE` token. Imported by feature modules that persist
 * user-uploaded binaries (users for avatars, reviews for road-review
 * photos, data-export for GDPR bundles).
 *
 * The provider choice is driven by `TARMOTO_STORAGE_DRIVER`
 * (`local` by default, `s3` opts into the S3-compatible backend).
 * See `docs/process/runbook.md` for env-var setup in staging/prod
 * and the local-MinIO recipe.
 */
@Module({
  imports: [ConfigModule],
  providers: [OBJECT_STORAGE_PROVIDER],
  exports: [OBJECT_STORAGE_PROVIDER],
})
export class StorageModule {}
