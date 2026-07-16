import { ApiProperty } from '@nestjs/swagger';
import type {
  RegionImportStatus,
  RunSummary,
  TriggerImportResponse,
} from '@tarmoto/ingest';

/**
 * One `poi_import_runs` row, serialized for the admin API (#847). Mirrors
 * `RunSummary` (`PoiImportAdminService`) — `implements` is a compile-time
 * shape guard that fails the build the moment the two drift apart.
 */
export class RunDto implements RunSummary {
  @ApiProperty() id!: string;
  @ApiProperty() source!: string;
  @ApiProperty() region_code!: string;
  @ApiProperty({ enum: ['running', 'success', 'skipped', 'failed'] })
  status!: string;
  @ApiProperty({ enum: ['manual', 'cron'] }) trigger!: string;
  @ApiProperty({ nullable: true }) fetched!: number | null;
  @ApiProperty({ nullable: true }) upserted!: number | null;
  @ApiProperty({ nullable: true }) tombstoned!: number | null;
  @ApiProperty({ nullable: true }) skip_reason!: string | null;
  @ApiProperty({ nullable: true }) warning!: string | null;
  @ApiProperty({ nullable: true }) error!: string | null;
  @ApiProperty() started_at!: string;
  @ApiProperty({ nullable: true }) finished_at!: string | null;
}

/**
 * Extract file presence/stat for one `(source, region)` — mirrors
 * `RegionImportStatus['extract']`. Doubles as the response body of the
 * upload endpoint: `PoiImportAdminService.storeExtract` narrows `present` to
 * the literal `true`, which is still assignable to this DTO's `boolean`.
 */
export class ExtractStatDto implements NonNullable<
  RegionImportStatus['extract']
> {
  @ApiProperty() present!: boolean;
  @ApiProperty() size_bytes!: number;
  @ApiProperty() modified_at!: string;
}

/**
 * Per-`(source, region)` admin status row — mirrors `RegionImportStatus`
 * (`PoiImportAdminService.listRegionStatus`).
 */
export class RegionImportStatusDto implements RegionImportStatus {
  @ApiProperty() source!: string;
  @ApiProperty() code!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty({ nullable: true }) imported_at!: string | null;
  @ApiProperty() poi_count!: number;
  @ApiProperty({ type: ExtractStatDto, nullable: true })
  extract!: ExtractStatDto | null;
  @ApiProperty({ type: RunDto, nullable: true })
  last_run!: RunDto | null;
  @ApiProperty({ enum: ['idle', 'queued', 'running'] })
  live_state!: 'idle' | 'queued' | 'running';
}

/**
 * Response body of `POST /admin/poi/regions/:source/:code/import` — mirrors
 * `PoiImportAdminService.triggerImport`'s return shape.
 */
export class TriggerImportResponseDto implements TriggerImportResponse {
  @ApiProperty() job_id!: string;
}
