import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import { AdminAuditLog } from '../../entities/admin-audit-log.entity.js';
import type { AdminRole } from '../../entities/admin-user.entity.js';
import type { AdminRequest } from './internal.guard.js';
import { getAdminAuditTarget } from './admin-audit-context.js';

export interface AdminAuditEntry {
  event_key: string;
  outcome: 'allowed' | 'denied';
  method: string;
  path: string;
  admin_user_id: string | null;
  admin_role: AdminRole | null;
  target_type?: string | null;
  target_id?: string | null;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger('AdminAuditService');

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async record(entry: AdminAuditEntry): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          event_key: entry.event_key,
          outcome: entry.outcome,
          method: entry.method,
          path: entry.path,
          admin_user_id: entry.admin_user_id,
          admin_role: entry.admin_role,
          target_type: entry.target_type ?? null,
          target_id: entry.target_id ?? null,
          metadata: entry.metadata,
        }),
      );
    } catch (err) {
      // Best-effort: auditing must never break the request it observes.
      this.logger.error(
        `audit persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Must match the global prefix set by app.setGlobalPrefix() in main.ts.
const API_GLOBAL_PREFIX = '/api/v1';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const method = request.method ?? 'GET';
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];

    // Strip the global prefix before deciding whether this is an admin request
    // so that prod routes under /api/v1/admin/... are audited correctly.
    const normalizedPath = path.startsWith(API_GLOBAL_PREFIX)
      ? path.slice(API_GLOBAL_PREFIX.length) || '/'
      : path;

    if (!normalizedPath.startsWith('/admin/')) return next.handle();

    return next.handle().pipe(
      tap(() => {
        if (!MUTATING.has(method)) return;
        const target = getAdminAuditTarget(request);
        void this.audit.record({
          event_key: `admin.${method.toLowerCase()}`,
          outcome: 'allowed',
          method,
          path,
          admin_user_id: request.adminUser?.id ?? null,
          admin_role: request.adminUser?.role ?? null,
          target_type: target?.target_type ?? null,
          target_id: target?.target_id ?? null,
          metadata: null,
        });
      }),
    );
  }
}
