import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  ImportStatusResponse,
  RegionImportStatus,
  RunSummary,
  TriggerImportResponse,
} from "@tarmoto/ingest";
import { IngestInternalGuard } from "./internal.guard.js";
import { PoiInternalService } from "./poi-internal.service.js";
import { TriggerImportRequestDto } from "./dto/trigger-import.dto.js";

/**
 * apps/ingest internal API (Phase 3), server-to-server only — the backend
 * admin proxy is the sole caller. `IngestInternalGuard` gates it with the
 * shared `x-internal-token`; /healthz stays open (controller-scoped guard).
 */
@Controller("internal/poi")
@UseGuards(IngestInternalGuard)
export class PoiInternalController {
  constructor(private readonly svc: PoiInternalService) {}

  @Get("regions")
  regions(): Promise<RegionImportStatus[]> {
    return this.svc.listRegionStatus();
  }

  @Get("runs")
  runs(
    @Query("source") source?: string,
    @Query("code") code?: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ): Promise<RunSummary[]> {
    return this.svc.listRuns({
      ...(source !== undefined ? { source } : {}),
      ...(code !== undefined ? { code } : {}),
      limit,
    });
  }

  /**
   * Cheap in-flight check (#1011 review, FIX 2) — the backend's
   * `storeExtract` calls this best-effort before writing a replacement
   * extract, restoring the upload-vs-import guard Phase 3 dropped when the
   * `poi.import` queue moved entirely into this app.
   */
  @Get("import-status")
  importStatus(
    @Query("source") source: string,
    @Query("code") code: string,
  ): Promise<ImportStatusResponse> {
    return this.svc.importStatus(source, code);
  }

  @Post("import")
  triggerImport(
    @Body() body: TriggerImportRequestDto,
  ): Promise<TriggerImportResponse> {
    return this.svc.triggerImport(body.source, body.code, body.trigger);
  }
}
