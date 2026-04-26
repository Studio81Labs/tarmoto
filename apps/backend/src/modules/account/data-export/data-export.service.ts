import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DataExportRequest } from '../../../entities/data-export-request.entity.js';
import { DataExportRequestDto } from './dto/data-export-request.dto.js';
import { signDownloadUrl } from './signed-url.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';

const ACTIVE: DataExportRequest['status'][] = ['queued', 'processing', 'ready'];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    @InjectRepository(DataExportRequest)
    private readonly repo: Repository<DataExportRequest>,
    private readonly config: ConfigService,
    @Inject(EXPORT_STORAGE)
    private readonly storage: ExportStorage,
  ) {}

  async requestExport(
    userId: string,
  ): Promise<{ created: boolean; request: DataExportRequest }> {
    // Fast path: an existing row inside its TTL is the answer.
    const active = await this.repo.findOne({
      where: { user_id: userId, status: In(ACTIVE) },
      order: { created_at: 'DESC' },
    });
    if (active && active.expires_at.getTime() > Date.now()) {
      return { created: false, request: active };
    }
    // Past-TTL row — sweep it out so the partial unique index lets us
    // insert a new one and so the stale ZIP doesn't linger on disk.
    if (active) {
      await this.expireAndCleanup(active);
    }

    const draft = this.repo.create({
      user_id: userId,
      status: 'queued',
      expires_at: new Date(Date.now() + TTL_MS),
    });
    try {
      const saved = await this.repo.save(draft);
      return { created: true, request: saved };
    } catch (err) {
      // Concurrent POST raced us through the unique index. Whoever won
      // already has a queued/processing/ready row — return that.
      if (isUniqueViolation(err)) {
        const winner = await this.repo.findOne({
          where: { user_id: userId, status: In(ACTIVE) },
          order: { created_at: 'DESC' },
        });
        if (winner) {
          return { created: false, request: winner };
        }
      }
      throw err;
    }
  }

  private async expireAndCleanup(row: DataExportRequest): Promise<void> {
    if (row.storage_key) {
      try {
        await this.storage.delete(row.storage_key);
      } catch (err) {
        // Best-effort cleanup: log and continue. The DB transition still
        // happens so future requests aren't blocked by the unique index.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `failed to delete expired export ${row.id} at ${row.storage_key}: ${msg}`,
        );
      }
    }
    await this.repo.update({ id: row.id }, { status: 'expired' });
  }

  async getRequest(
    userId: string,
    id: string,
  ): Promise<DataExportRequest | null> {
    return this.repo.findOne({ where: { id, user_id: userId } });
  }

  async findById(id: string): Promise<DataExportRequest | null> {
    return this.repo.findOne({ where: { id } });
  }

  async markProcessing(id: string): Promise<void> {
    await this.repo.update({ id }, { status: 'processing' });
  }

  async markReady(
    id: string,
    storageKey: string,
    byteSize: number,
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        status: 'ready',
        storage_key: storageKey,
        byte_size: String(byteSize),
        completed_at: new Date(),
      },
    );
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.repo.update(
      { id },
      { status: 'failed', error_message: message.slice(0, 1000) },
    );
  }

  buildPublicView(request: DataExportRequest): DataExportRequestDto {
    // Surface any non-terminal row past its TTL as 'expired'. Three
    // failure modes converge here: a ready row past TTL would yield a
    // dead-on-arrival download URL; a queued/processing row past TTL
    // means the worker crashed (or markFailed itself failed) and the
    // companion would otherwise poll forever, since its exit conditions
    // are ready/failed/expired only.
    const pastTtl = request.expires_at.getTime() <= Date.now();
    const isNonTerminal =
      request.status === 'queued' ||
      request.status === 'processing' ||
      request.status === 'ready';
    const effectiveStatus: DataExportRequest['status'] =
      pastTtl && isNonTerminal ? 'expired' : request.status;

    let downloadUrl: string | null = null;
    if (effectiveStatus === 'ready') {
      const exp = request.expires_at.getTime();
      const sig = signDownloadUrl({
        requestId: request.id,
        expiresAt: exp,
        secret: this.signingSecret(),
      });
      // The backend mounts every route under setGlobalPrefix('api/v1');
      // the public URL must include it or callers hit a 404.
      downloadUrl = `${this.publicBaseUrl()}/api/v1/account/data-export/${request.id}/download?sig=${sig}&exp=${exp}`;
    }
    return {
      id: request.id,
      status: effectiveStatus,
      expiresAt: request.expires_at.toISOString(),
      createdAt: request.created_at.toISOString(),
      completedAt: request.completed_at?.toISOString() ?? null,
      downloadUrl,
      byteSize: request.byte_size ? Number(request.byte_size) : null,
      errorMessage: request.error_message,
    };
  }

  signingSecret(): string {
    const v = this.config.get<string>('TARMOTO_EXPORT_SIGNING_SECRET');
    if (!v) {
      throw new Error('TARMOTO_EXPORT_SIGNING_SECRET is not configured');
    }
    return v;
  }

  private publicBaseUrl(): string {
    return (
      this.config.get<string>('TARMOTO_PUBLIC_BASE_URL') ??
      'http://localhost:3000'
    );
  }
}
