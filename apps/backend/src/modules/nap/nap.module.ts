import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { napConfig } from './nap.config.js';
import { NapClientService } from './nap-client.service.js';
import { Datex2ParserService } from './datex2-parser.service.js';
import { NapReconcileService } from './nap-reconcile.service.js';
import { NapService } from './nap.service.js';

/**
 * Czech NAP (NDIC) DATEX II closure ingestion (#743). Polls the pull
 * snapshot, parses it, and reconciles into `road_closures` with
 * `source = 'official'` alongside operator-entered rows. The recurring
 * poll trigger lives in the jobs module (BullMQ); this module owns the
 * fetch/parse/reconcile services it calls.
 *
 * No controller yet: the feed's closures are served through the existing
 * `/closures` endpoints. A `GET /nap/closures/status` health endpoint
 * lands with the go-live PR (typed response DTO + an OpenAPI
 * regeneration) so the generated contract never drifts.
 */
@Module({
  imports: [
    ConfigModule.forFeature(napConfig),
    TypeOrmModule.forFeature([RoadClosure]),
  ],
  providers: [
    NapClientService,
    Datex2ParserService,
    NapReconcileService,
    NapService,
  ],
  exports: [NapService],
})
export class NapModule {}
