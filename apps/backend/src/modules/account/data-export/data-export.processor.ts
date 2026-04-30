import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { EmailService } from '../../email/email.service.js';
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
    private readonly email: EmailService,
  ) {}

  async process(requestId: string, userId: string): Promise<void> {
    try {
      const claimed = await this.service.markProcessing(requestId);
      if (!claimed) {
        // Row was already moved off 'queued' by something else — most
        // likely expireAndCleanup swept it as stuck after a long delay
        // before this setImmediate finally fired. Bail without writing
        // any storage so we don't orphan a ZIP under a row that now
        // belongs to a fresh request the user just made.
        this.logger.warn(
          `export ${requestId} skipped: row no longer 'queued' at claim time`,
        );
        return;
      }
      // No explicit select: rely on the entity's `select: false` columns
      // (e.g. password_hash) to stay out, and on the assembler's
      // sanitizer to strip stripe identifiers. Listing columns here was
      // a maintenance trap — every new User column would silently drop
      // out of the GDPR export until someone remembered to add it.
      const user = await this.users.findOne({ where: { id: userId } });
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

      // GDPR Art. 15 right-of-access: notify the rider that their
      // bundle is ready. Best-effort fire-and-forget — a transient
      // mail-provider failure must NOT bubble up here, since the row
      // is already 'ready' and the user can still poll the API for
      // the status. Re-fetch the row to get the current
      // `expires_at`; `buildPublicView` rebuilds the signed
      // download URL with the same TTL the controller uses, so the
      // email link points at the same endpoint a UI poll would use.
      const ready = await this.service.findById(requestId);
      if (ready && ready.status === 'ready' && user.email) {
        const view = this.service.buildPublicView(ready);
        if (view.downloadUrl) {
          this.email
            .sendDataExportReady(user.email, {
              displayName: user.display_name,
              downloadUrl: view.downloadUrl,
              expiresAt: new Date(view.expiresAt),
            })
            .catch((mailErr) => {
              const mailMsg =
                mailErr instanceof Error ? mailErr.message : String(mailErr);
              this.logger.warn(
                `data export ${requestId} mail send failed: ${mailMsg}`,
              );
            });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`export ${requestId} failed: ${msg}`);
      // markFailed itself can throw (transient DB error in exactly the
      // failure mode we're trying to record). Swallow that so the
      // rejection doesn't escape — the row is left in 'processing' and
      // the next requestExport call will treat it as active until its
      // TTL passes, which is preferable to crashing the worker.
      try {
        await this.service.markFailed(requestId, msg);
      } catch (markErr) {
        const markMsg =
          markErr instanceof Error ? markErr.message : String(markErr);
        this.logger.error(
          `failed to record failure for export ${requestId}: ${markMsg}`,
        );
      }
    }
  }
}
