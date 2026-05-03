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
import { OBJECT_STORAGE } from '../../storage/storage.tokens.js';
import type { ObjectStorage } from '../../storage/object-storage.interface.js';
import { verifyDownloadSignature } from './signed-url.js';
import { JOB_NAMES, QUEUE_NAMES } from '../../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../../jobs/jobs.config.js';
import type { DataExportJobData } from '../../jobs/jobs.producer.js';

// Short TTL for the bucket-native pre-signed URL: the user is
// redirected to it the instant they hit our `/download` endpoint, so
// 5 minutes is more than enough for any realistic download to start
// AND complete. Longer TTLs would let the bucket URL outlive the
// per-user HMAC check we just performed.
const DOWNLOAD_TTL_SECONDS = 5 * 60;

@ApiTags('account')
@Controller('account/data-export')
export class DataExportController {
  private readonly logger = new Logger(DataExportController.name);

  constructor(
    private readonly service: DataExportService,
    @InjectQueue(QUEUE_NAMES.DATA_EXPORT)
    private readonly queue: Queue<DataExportJobData>,
    @Inject(OBJECT_STORAGE)
    private readonly storage: ObjectStorage,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Request a GDPR data export bundle for the caller',
    description:
      'Returns 202 if a new request was created, 200 if an active request already exists, or 503 if the queue is temporarily unreachable (caller should retry). The bundle is assembled asynchronously; poll GET /account/data-export/:id until status is "ready", then follow downloadUrl.',
  })
  @ApiResponse({ status: 202, type: DataExportRequestDto })
  @ApiResponse({ status: 200, type: DataExportRequestDto })
  @ApiResponse({ status: 503 })
  async create(
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    const userId = req.user!.userId;
    const { created, request } = await this.service.requestExport(userId);
    const view = this.service.buildPublicView(request);
    if (!created) {
      res.status(200).json(view);
      return;
    }

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
      // Redis was unreachable when we tried to dispatch. The DB row
      // is in 'queued' but no job exists to drain it — without a
      // rollback, subsequent requestExport calls within the 30-minute
      // "stuck worker" threshold treat this row as still-active and
      // skip the re-enqueue branch, leaving the user stuck for half
      // an hour. Roll the row to 'failed' so the next POST creates a
      // fresh request, then surface 503 so the caller knows to retry
      // immediately. The Retry-After hint is conservative — the
      // typical Redis outage is seconds, but a hint > 0 is what
      // RFC-9110 expects from a 503.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to enqueue data-export ${request.id} for user ${userId}: ${msg}`,
      );
      try {
        await this.service.markEnqueueFailed(
          request.id,
          `enqueue failed: ${msg}`,
        );
      } catch (rollbackErr) {
        // The DB itself is also flaky. Don't crash — the worst case
        // is the user waits up to 30 minutes for the stuck-row TTL
        // to clear, which is the legacy behaviour anyway.
        const rollbackMsg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        this.logger.error(
          `Failed to mark data-export ${request.id} failed after enqueue error: ${rollbackMsg}`,
        );
      }
      res.set('Retry-After', '30');
      res.status(503).json({
        status: 'unavailable',
        message: 'Queue temporarily unavailable, please retry.',
      });
      return;
    }

    res.status(202).json(view);
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
      'Authenticated via the signed URL produced by the create/status endpoints; bearer auth not required. When the backend is configured against an S3-compatible bucket the response is a 302 to a short-lived bucket-native pre-signed URL; otherwise the ZIP is streamed inline.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'application/zip stream' })
  @ApiResponse({
    status: 302,
    description: 'redirect to bucket-native pre-signed download URL',
  })
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

    // When the storage backend exposes a native pre-signed URL (S3/R2),
    // redirect the client straight at it rather than streaming through
    // the backend. This keeps the GDPR ZIP off the API replicas'
    // bandwidth/CPU and lets the bucket's CDN edge handle the transfer.
    // `LocalStorage.signedUrl` returns a server-relative `/uploads/...`
    // path (the same value as `publicUrl`) — redirecting there would
    // hit the static-files middleware unauthenticated and expose
    // personal data, so the absolute-URL check below is the gate.
    let signed: string | null = null;
    try {
      signed = await this.storage.signedUrl(
        row.storage_key,
        DOWNLOAD_TTL_SECONDS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `signedUrl failed for export ${id} key ${row.storage_key}; falling back to stream: ${msg}`,
      );
    }
    const redirectUrl = signed && /^https?:\/\//i.test(signed) ? signed : null;
    if (redirectUrl) {
      // Pre-signed URL generation is a CPU-only op that doesn't probe
      // the bucket, so a row whose ZIP was already swept (lifecycle
      // rule, operator cleanup) would still hand the client a working-
      // looking redirect — the user would then hit a raw S3 404 XML
      // instead of our documented 410. Confirm the object is present
      // before sending the 302.
      let existsVerdict: 'present' | 'gone' | 'unknown';
      try {
        existsVerdict = (await this.storage.exists(row.storage_key))
          ? 'present'
          : 'gone';
      } catch (err) {
        // Mirrors `DataExportService.isRowReusable`: a transient
        // exists() failure (S3 5xx) is not strong enough evidence to
        // 410. Fall through to the streaming path, whose `read()`
        // surfaces a real 404 if the object truly is gone.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `storage.exists failed for ${row.storage_key} before redirect (falling back to stream): ${msg}`,
        );
        existsVerdict = 'unknown';
      }
      if (existsVerdict === 'present') {
        res.redirect(302, redirectUrl);
        return;
      }
      if (existsVerdict === 'gone') {
        throw new HttpException('not available', 410);
      }
      // 'unknown' → drop into the streaming branch below.
    }

    let stream;
    try {
      stream = await this.storage.read(row.storage_key);
    } catch (err) {
      // Storage object missing/unreadable while the row says ready —
      // treat as gone (e.g. operator-side cleanup or partial expire).
      // S3 surfaces a 404 via NoSuchKey rather than ENOENT, so we
      // probe both.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (code === 'ENOENT' || status === 404) {
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
