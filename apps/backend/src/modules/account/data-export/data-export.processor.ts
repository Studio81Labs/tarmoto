import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { DataExportService } from './data-export.service.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';
import { BundleAssembler } from './assembler/bundle-assembler.js';

@Injectable()
export class DataExportProcessor {
  private readonly logger = new Logger(DataExportProcessor.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly service: DataExportService,
    @Inject(EXPORT_STORAGE)
    private readonly storage: ExportStorage,
    private readonly assembler: BundleAssembler,
  ) {}

  async process(requestId: string, userId: string): Promise<void> {
    try {
      await this.service.markProcessing(requestId);
      const user = await this.users.findOne({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          phone: true,
          avatar_url: true,
          bio: true,
          home_region: true,
          home_location: true,
          work_location: true,
          preferences: true,
          subscription_tier: true,
          subscription_status: true,
          created_at: true,
          updated_at: true,
        },
      });
      if (!user) {
        await this.service.markFailed(requestId, 'user not found');
        return;
      }
      const archiveStream = await this.assembler.assemble(user);
      const key = `${userId}/${requestId}.zip`;
      const { byteSize } = await this.storage.write(key, archiveStream);
      await this.service.markReady(requestId, key, byteSize);
      this.logger.log(
        `data export ${requestId} ready (${byteSize} bytes) for user ${userId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`export ${requestId} failed: ${msg}`);
      await this.service.markFailed(requestId, msg);
    }
  }
}
