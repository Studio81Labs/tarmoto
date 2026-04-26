import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DataExportRequest } from '../../../entities/data-export-request.entity.js';
import { DataExportRequestDto } from './dto/data-export-request.dto.js';
import { signDownloadUrl } from './signed-url.js';

const ACTIVE: DataExportRequest['status'][] = ['queued', 'processing', 'ready'];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class DataExportService {
  constructor(
    @InjectRepository(DataExportRequest)
    private readonly repo: Repository<DataExportRequest>,
    private readonly config: ConfigService,
  ) {}

  async requestExport(
    userId: string,
  ): Promise<{ created: boolean; request: DataExportRequest }> {
    const active = await this.repo.findOne({
      where: { user_id: userId, status: In(ACTIVE) },
      order: { created_at: 'DESC' },
    });
    if (active && active.expires_at.getTime() > Date.now()) {
      return { created: false, request: active };
    }
    const draft = this.repo.create({
      user_id: userId,
      status: 'queued',
      expires_at: new Date(Date.now() + TTL_MS),
    });
    const saved = await this.repo.save(draft);
    return { created: true, request: saved };
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
    let downloadUrl: string | null = null;
    if (request.status === 'ready') {
      const exp = request.expires_at.getTime();
      const sig = signDownloadUrl({
        requestId: request.id,
        expiresAt: exp,
        secret: this.signingSecret(),
      });
      downloadUrl = `${this.publicBaseUrl()}/account/data-export/${request.id}/download?sig=${sig}&exp=${exp}`;
    }
    return {
      id: request.id,
      status: request.status,
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
