import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type PoiImportRunStatus = "running" | "success" | "skipped" | "failed";
export type PoiImportTrigger = "manual" | "cron";

/**
 * One row per POI import execution attempt (#847 admin management) — cron AND
 * manual, written by PoiImportProcessor. Lives on the POI DB alongside `pois`.
 */
@Entity("poi_import_runs")
@Index("idx_poi_import_runs_region_source_started", [
  "region_code",
  "source",
  "started_at",
])
export class PoiImportRun {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 32 })
  source!: string;

  @Column({ name: "region_code", type: "varchar", length: 2 })
  region_code!: string;

  @Column({ type: "varchar", length: 16 })
  status!: PoiImportRunStatus;

  @Column({ type: "varchar", length: 16 })
  trigger!: PoiImportTrigger;

  @Column({ type: "int", nullable: true })
  fetched!: number | null;

  @Column({ type: "int", nullable: true })
  upserted!: number | null;

  @Column({ type: "int", nullable: true })
  tombstoned!: number | null;

  @Column({ name: "skip_reason", type: "text", nullable: true })
  skip_reason!: string | null;

  /**
   * Advisory for a `success` run that withheld part of its normal work (#847
   * review) — currently only the tombstone wipe-guard's partial-accept path
   * (see `PoiImportResult.warning`). Null on every clean success, both skip
   * statuses, and every `running`/`failed` row.
   */
  @Column({ type: "text", nullable: true })
  warning!: string | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({ name: "job_id", type: "varchar", length: 200, nullable: true })
  job_id!: string | null;

  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" })
  started_at!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finished_at!: Date | null;
}
