import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { POI_IMPORT_QUEUE } from "@tarmoto/ingest";
import { PoiImportRun } from "@tarmoto/poi-db";
import { PoiModule } from "../poi/poi.module.js";
import { PoiDatabaseModule } from "../poi/poi-database.module.js";
import { IngestInternalGuard } from "./internal.guard.js";
import { PoiInternalController } from "./poi-internal.controller.js";
import { PoiInternalService } from "./poi-internal.service.js";

/**
 * The apps/ingest internal API (Phase 3): a token-guarded /internal/poi/*
 * controller the backend admin proxy calls. Reuses PoiModule's
 * POI_IMPORT_SOURCES registry (enablement + extract paths) + the "poi"
 * connection; registers the poi.import queue token locally so the service can
 * @InjectQueue it for live-state + the manual enqueue.
 */
@Module({
  imports: [
    PoiModule,
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], "poi"),
    BullModule.registerQueue({ name: POI_IMPORT_QUEUE }),
  ],
  controllers: [PoiInternalController],
  providers: [PoiInternalService, IngestInternalGuard],
})
export class PoiInternalModule {}
