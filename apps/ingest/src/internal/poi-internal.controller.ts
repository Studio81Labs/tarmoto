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

  @Post("import")
  triggerImport(
    @Body() body: TriggerImportRequestDto,
  ): Promise<TriggerImportResponse> {
    return this.svc.triggerImport(body.source, body.code, body.trigger);
  }
}
