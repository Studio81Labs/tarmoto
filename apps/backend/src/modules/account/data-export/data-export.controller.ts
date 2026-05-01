import {
  Controller,
  Get,
  HttpException,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { pipeline } from 'node:stream/promises';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type * as express from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { DataExportService } from './data-export.service.js';
import { DataExportRequestDto } from './dto/data-export-request.dto.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';
import { verifyDownloadSignature } from './signed-url.js';
import { JOB_NAMES, QUEUE_NAMES } from '../../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../../jobs/jobs.config.js';
import type { DataExportJobData } from '../../jobs/jobs.producer.js';

@ApiTags('account')
@Controller('account/data-export')
export class DataExportController {
  private readonly logger = new Logger(DataExportController.name);

  constructor(
    private readonly service: DataExportService,
    @InjectQueue(QUEUE_NAMES.DATA_EXPORT)
    private readonly queue: Queue<DataExportJobData>,
    @Inject(EXPORT_STORAGE)
    private readonly storage: ExportStorage,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Request a GDPR data export bundle for the caller',
    description:
      'Returns 202 if a new request was created, 200 if an active request already exists. The bundle is assembled asynchronously; poll GET /account/data-export/:id until status is "ready", then follow downloadUrl.',
  })
  @ApiResponse({ status: 202, type: DataExportRequestDto })
  @ApiResponse({ status: 200, type: DataExportRequestDto })
  async create(
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    const userId = req.user!.userId;
    const { created, request } = await this.service.requestExport(userId);
    const view = this.service.buildPublicView(request);
    if (created) {
      try {
        // Idempotent on request_id: a retried HTTP call hitting the
        // existing-request branch above never reaches this enqueue,
        // and a duplicate enqueue with the same jobId is a no-op.
        await this.queue.add(
          JOB_NAMES.DATA_EXPORT_PROCESS,
          { request_id: request.id, user_id: userId },
          {
            ...DEFAULT_JOB_OPTIONS,
            jobId: `data-export:${request.id}`,
          },
        );
      } catch (err) {
        // The DB row is already 'queued' but Redis was unreachable —
        // leave the row in place so the next requestExport call (or
        // a manual operator nudge) can re-enqueue. The user sees a
        // 202 with the queued status they can poll, which matches
        // every other transient backend issue we surface.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to enqueue data-export ${request.id} for user ${userId}: ${msg}`,
        );
      }
      res.status(202).json(view);
    } else {
      res.status(200).json(view);
    }
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the status of a data export request' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: DataExportRequestDto })
  @ApiResponse({ status: 404 })
  async get(
    @Req() req: express.Request,
    @Param('id') id: string,
  ): Promise<DataExportRequestDto> {
    const userId = req.user!.userId;
    const row = await this.service.getRequest(userId, id);
    if (!row) {
      throw new HttpException('not found', 404);
    }
    return this.service.buildPublicView(row);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download a ready data export bundle (signed URL)',
    description:
      'Authenticated via the signed URL produced by the create/status endpoints; bearer auth not required.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'application/zip stream' })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 410 })
  async download(
    @Param('id') id: string,
    @Query('sig') signature: string,
    @Query('exp') expiresAtRaw: string,
    @Res() res: express.Response,
  ): Promise<void> {
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || !signature) {
      throw new HttpException('missing signature', 403);
    }
    // Cheap cross-cutting check first: if the URL is past its claimed
    // expiry, no DB lookup is needed and we can short-circuit.
    if (Date.now() > expiresAt) {
      throw new HttpException('link expired', 410);
    }

    // Load the row before verifying — the signature is now bound to
    // user_id, which we can only get from the row itself. To avoid
    // leaking row existence to URL-probers, fold "no row" / "wrong
    // status" into the same 403 the bad-signature path returns.
    const row = await this.service.findById(id);
    if (!row || row.status !== 'ready' || !row.storage_key) {
      throw new HttpException('invalid signature', 403);
    }

    const verdict = verifyDownloadSignature({
      userId: row.user_id,
      requestId: id,
      expiresAt,
      signature,
      secret: this.service.signingSecret(),
    });
    if (verdict === 'expired') {
      throw new HttpException('link expired', 410);
    }
    if (verdict !== 'valid') {
      throw new HttpException('invalid signature', 403);
    }
    if (row.expires_at.getTime() < Date.now()) {
      throw new HttpException('link expired', 410);
    }

    let stream;
    try {
      stream = await this.storage.read(row.storage_key);
    } catch (err) {
      // Storage object missing/unreadable while the row says ready —
      // treat as gone (e.g. operator-side cleanup or partial expire).
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        throw new HttpException('not available', 410);
      }
      throw err;
    }

    res.set('Content-Type', 'application/zip');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-export-${id}.zip"`,
    );
    try {
      // pipeline() forwards source/destination errors and propagates
      // client disconnect (res 'close') as an aborted error, so we
      // don't leak file handles on broken connections.
      await pipeline(stream, res);
    } catch (err) {
      // The response is already streaming, so we can't send a fresh
      // status — log and let the open connection close. Without this
      // catch the rejection becomes an unhandled promise rejection
      // and crashes the process under strict mode.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`download stream for export ${id} ended early: ${msg}`);
    }
  }
}
