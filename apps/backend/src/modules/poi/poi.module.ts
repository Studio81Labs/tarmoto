import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import { PoiImportAdminService } from './poi-import-admin.service.js';
import { PoiDatabaseModule } from './poi-database.module.js';
import { PoiImportRun } from '@tarmoto/poi-db';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 *
 * The bulk IMPORT ENGINE (`PoiImportService`'s two OSM/FSQ instances,
 * `PoiImportRunRecorder`, the `poi.import` worker + scheduler) moved to
 * apps/ingest (Task 5, POI-ingestion extraction). This module is now a
 * reader + producer-only front-door: `PoiService`/`PoiStoreService` serve
 * reads, and `PoiImportAdminService` reads region/extract metadata from
 * `@tarmoto/ingest` + its own env directly (no injected importer registry)
 * and enqueues manual `poi.import` region jobs via the queue below —
 * apps/ingest owns the connection's actual worker/scheduler.
 */
@Module({
  imports: [
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], 'poi'),
    // Register the poi.import queue TOKEN so PoiImportAdminService can
    // `@InjectQueue` it (enqueue manual triggers + probe `getJobs` for
    // live_state). The connection + the actual worker/scheduler now live in
    // apps/ingest (Task 5) — this registration is producer-only, mirroring
    // admin.module's identical registerQueue for DIGEST_WEEKLY and
    // data-export.module for DATA_EXPORT.
    BullModule.registerQueue({ name: QUEUE_NAMES.POI_IMPORT }),
  ],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportAdminService,
  ],
  exports: [PoiService, PoiImportAdminService],
})
export class PoiModule {}
