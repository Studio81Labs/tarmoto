import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import { setAdminAuditTarget } from './admin-audit-context.js';
import { PoiUploadLockInterceptor } from './poi-upload-lock.interceptor.js';
import type { AdminRequest } from './internal.guard.js';
import {
  POI_UPLOAD_MAX_BYTES,
  PoiImportAdminService,
} from '../poi/poi-import-admin.service.js';
import {
  ExtractStatDto,
  RegionImportStatusDto,
  RunDto,
  TriggerImportResponseDto,
} from './dto/poi-import-admin.dto.js';

/**
 * Admin surface for the POI import system (#847) — a thin HTTP layer over
 * `PoiImportAdminService` (status reads, extract upload, manual trigger, run
 * history).
 *
 * `InternalGuard` (admin auth) and `AdminAuditInterceptor` (mutation audit
 * log) both already apply globally to every `/admin/*` route via
 * `APP_GUARD`/`APP_INTERCEPTOR` registered once in `AdminModule` — see
 * `admin-metrics.controller.ts` and every other `admin-*.controller.ts`,
 * none of which re-declare `@UseGuards(InternalGuard)` /
 * `@UseInterceptors(AdminAuditInterceptor)` locally. Re-adding them here
 * would run BOTH a second time per request: harmless for the guard's
 * auth check, but `AdminAuditInterceptor` unconditionally inserts an audit
 * row for every mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request, so a local
 * re-declaration would double-insert an audit row for every manual trigger
 * and every extract upload below.
 */
@ApiTags('admin')
@Controller('admin/poi')
export class AdminPoiController {
  constructor(private readonly svc: PoiImportAdminService) {}

  @Get('regions')
  @AdminRoles('support')
  @ApiOperation({
    summary: 'Per-(source, region) import status, across OSM + FSQ OS',
  })
  @ApiResponse({ status: 200, type: [RegionImportStatusDto] })
  regions(): Promise<RegionImportStatusDto[]> {
    return this.svc.listRegionStatus();
  }

  @Get('runs')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Recent poi_import_runs history, newest first' })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max rows to return (clamped to 1-200, default 50).',
  })
  @ApiResponse({ status: 200, type: [RunDto] })
  runs(
    @Query('source') source?: string,
    @Query('code') code?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
  ): Promise<RunDto[]> {
    return this.svc.listRuns({
      // Conditionally spread rather than passing `source`/`code` straight
      // through: both are `string | undefined` here, but
      // `PoiImportAdminService.listRuns`'s filter types them as merely
      // OPTIONAL (`source?: string`, no explicit `| undefined`), and this
      // repo's `exactOptionalPropertyTypes` tsconfig flag treats "key
      // present with an `undefined` value" as distinct from — and NOT
      // assignable to — "key omitted" (mirrors the same
      // `...(x !== undefined ? { x } : {})` idiom already used in
      // `poi-database.module.ts`'s `buildPoiTypeOrmOptions`).
      ...(source !== undefined ? { source } : {}),
      ...(code !== undefined ? { code } : {}),
      limit: Math.min(Math.max(limit, 1), 200),
    });
  }

  @Post('regions/:source/:code/import')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Manually trigger an import for (source, code)' })
  @ApiResponse({ status: 201, type: TriggerImportResponseDto })
  @ApiResponse({ status: 400, description: 'Unknown source or region code' })
  @ApiResponse({
    status: 409,
    description: 'An import for (source, code) is already queued or running',
  })
  triggerImport(
    @Req() req: AdminRequest,
    @Param('source') source: string,
    @Param('code') code: string,
  ): Promise<TriggerImportResponseDto> {
    setAdminAuditTarget(req, {
      target_type: 'poi_import',
      target_id: `${source}/${code}`,
    });
    return this.svc.triggerImport(source, code);
  }

  @Post('regions/:source/:code/extract')
  @AdminRoles('admin')
  @UseInterceptors(
    // ORDER MATTERS: the lock interceptor runs BEFORE FileInterceptor so it
    // holds the per-(source, code) upload lock before Multer drains the body,
    // and rejects a concurrent same-region upload with 409 before a byte is
    // read (#972). FileInterceptor only runs if the lock was acquired.
    PoiUploadLockInterceptor,
    FileInterceptor('file', {
      // Disk (not memory) storage: an operator-provided extract can be up to
      // POI_UPLOAD_MAX_BYTES (default 200 MB), so it must never sit fully
      // buffered in process memory. `diskStorage({})` — no destination or
      // filename override — is multer's own default disk engine: it writes
      // to `os.tmpdir()` under a random 32-character hex name, and (per
      // multer's own `make-middleware.js`) already unlinks that file itself
      // if THIS `limits.fileSize` cap aborts the upload mid-stream.
      storage: diskStorage({}),
      limits: { fileSize: POI_UPLOAD_MAX_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a pre-produced extract for (source, code)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, type: ExtractStatDto })
  @ApiResponse({
    status: 400,
    description:
      'No file, unknown source/region, wrong extension for the source, or oversize',
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the configured upload size cap',
  })
  async uploadExtract(
    @Req() req: AdminRequest,
    @Param('source') source: string,
    @Param('code') code: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ExtractStatDto> {
    if (!file) {
      throw new BadRequestException('extract file is required');
    }
    setAdminAuditTarget(req, {
      target_type: 'poi_import',
      target_id: `${source}/${code}`,
    });
    // Captured in a variable (rather than inlined into the call below) so a
    // rejection from `storeExtract` can still reach and `destroy()` it:
    // `storeExtract` validates size/source/code/extension BEFORE it ever
    // starts reading from the stream, so on every rejected upload this
    // stream would otherwise sit open and unconsumed — its fd leaking until
    // process exit — since nothing else ever reads or closes it.
    const stream = createReadStream(file.path);
    try {
      // `storeExtract` streams this into its OWN atomic temp+rename dance
      // under the importer's extract dir — a SEPARATE file from multer's
      // own disk-temp file at `file.path`, which is cleaned up below.
      return await this.svc.storeExtract(source, code, {
        stream,
        size: file.size,
        originalName: file.originalname,
      });
    } catch (err) {
      // On success, `storeExtract`'s own `pipeline()` already consumed and
      // closed this stream, so this branch only runs on rejection — where
      // the stream was never opened for reading and needs an explicit
      // `destroy()` to release its fd.
      stream.destroy();
      throw err;
    } finally {
      // Best-effort cleanup of MULTER's disk-temp file — success or
      // failure, it's ours to remove; Nest/multer never delete it once the
      // handler receives it. Mirrors `storeExtract`'s own
      // `unlink(...).catch(() => undefined)` convention: a failed cleanup
      // must never mask the primary result/error above.
      await unlink(file.path).catch(() => undefined);
    }
  }
}
