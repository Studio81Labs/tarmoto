import {
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type * as express from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { DataExportProcessor } from './data-export.processor.js';
import { DataExportService } from './data-export.service.js';
import { DataExportRequestDto } from './dto/data-export-request.dto.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';
import { verifyDownloadSignature } from './signed-url.js';

@ApiTags('account')
@Controller('account/data-export')
export class DataExportController {
  constructor(
    private readonly service: DataExportService,
    private readonly processor: DataExportProcessor,
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
      setImmediate(() => {
        void this.processor.process(request.id, userId);
      });
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
    const verdict = verifyDownloadSignature({
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

    const row = await this.service.findById(id);
    if (!row || row.status !== 'ready' || !row.storage_key) {
      throw new HttpException('not available', 410);
    }
    if (row.expires_at.getTime() < Date.now()) {
      throw new HttpException('link expired', 410);
    }

    const stream = await this.storage.read(row.storage_key);
    res.set('Content-Type', 'application/zip');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-export-${id}.zip"`,
    );
    stream.pipe(res);
  }
}
