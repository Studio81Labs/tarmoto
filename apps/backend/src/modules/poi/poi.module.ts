import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import { PoiImportAdminService } from './poi-import-admin.service.js';
import { PoiDatabaseModule } from './poi-database.module.js';
import {
  createPoiUploadLockRedis,
  POI_UPLOAD_LOCK_REDIS,
  PoiUploadLockRedisShutdownHook,
} from './poi-upload-lock-redis.js';

/**
 * POI module — Phase 3 reader + admin gateway. The bulk IMPORT ENGINE, the
 * `poi.import` queue, and the coverage/runs/enqueue data plane now live in
 * apps/ingest; `PoiImportAdminService` is a thin HTTP proxy to the ingest
 * internal API, plus the upload path (extract upload → shared volume) which
 * keeps a dedicated Redis client for its per-(source, code) upload lock.
 */
@Module({
  imports: [PoiDatabaseModule],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportAdminService,
    {
      provide: POI_UPLOAD_LOCK_REDIS,
      useFactory: createPoiUploadLockRedis,
      inject: [ConfigService],
    },
    PoiUploadLockRedisShutdownHook,
  ],
  exports: [PoiService, PoiImportAdminService],
})
export class PoiModule {}
