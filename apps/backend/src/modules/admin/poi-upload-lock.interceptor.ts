import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { PoiImportAdminService } from '../poi/poi-import-admin.service.js';
import type { AdminRequest } from './internal.guard.js';

/**
 * Holds the exclusive per-`(source, code)` upload lock across an extract upload
 * (#972). Ordered BEFORE `FileInterceptor` on
 * `POST /admin/poi/regions/:source/:code/extract`, so the lock is taken BEFORE
 * Multer streams the (up to `POI_UPLOAD_MAX_BYTES`) body — the window the
 * original in-`storeExtract` lock (#847) missed, where the lock wasn't held
 * during the client→API stream and `triggerImport`'s `uploadInProgress` guard
 * saw nothing.
 *
 * Because this runs first and throws BEFORE calling `next.handle()`, a
 * concurrent same-region upload that can't take the lock is rejected with a 409
 * and `FileInterceptor` never runs — the loser's body is never even drained.
 * The lock is owned (`SET … NX` with a per-request token) and released in the
 * rxjs `finalize` (success OR error) via a del-if-token-matches, so a request
 * only ever frees its own lock; the lock's TTL is the crash/abort backstop.
 */
@Injectable()
export class PoiUploadLockInterceptor implements NestInterceptor {
  constructor(private readonly svc: PoiImportAdminService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    // Route params are always present on this endpoint (`:source/:code`).
    const { source, code } = context.switchToHttp().getRequest<AdminRequest>()
      .params as { source: string; code: string };

    const token = await this.svc.acquireUploadLock(source, code);
    if (token === null) {
      throw new ConflictException(
        `an extract upload for ${source}/${code} is already in progress`,
      );
    }

    return next.handle().pipe(
      // Best-effort release on both completion and error; `releaseUploadLock`
      // swallows its own Redis errors and the TTL is the ultimate backstop.
      finalize(() => {
        void this.svc.releaseUploadLock(source, code, token);
      }),
    );
  }
}
