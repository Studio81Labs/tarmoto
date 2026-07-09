import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UnitSystem } from '@tarmoto/shared';
import { EmailLog } from '../../entities/email-log.entity.js';
import { User } from '../../entities/user.entity.js';
import { EmailService } from '../email/email.service.js';
import { JobsProducer } from '../jobs/jobs.producer.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import {
  AdminEmailLogListResponseDto,
  AdminEmailLogRowDto,
  ListAdminEmailLogQueryDto,
  ResendDigestResponseDto,
  TestDigestResponseDto,
} from './dto/admin-email.dto.js';

@Injectable()
export class AdminEmailService {
  constructor(
    @InjectRepository(EmailLog)
    private readonly emailLog: Repository<EmailLog>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly email: EmailService,
    private readonly jobs: JobsProducer,
    private readonly config: ConfigService,
  ) {}

  /**
   * Send a representative weekly digest to `toEmail` (the admin's own address)
   * so support can preview rendering / verify delivery without waiting for the
   * Sunday cron. Uses fixed sample data — it's a preview, not a real week.
   */
  async sendTestDigest(toEmail: string): Promise<TestDigestResponseDto> {
    const result = await this.email.sendWeeklyDigest(
      toEmail,
      sampleDigestContext(`${getCompanionUrl(this.config)}/explore`),
    );
    return { status: result ? 'sent' : 'failed' };
  }

  /**
   * Re-trigger a rider's weekly digest (support re-sending a failed one). Queues
   * a compose job that recomputes fresh ride/exploration data for the last 7
   * days and re-runs the same opt-in / no-activity gates — it is NOT a byte
   * replay (the log stores no body). Resolves the recipient address to a user;
   * 404s if none. Async: the actual send lands as a new email_log row.
   */
  async resendDigest(recipient: string): Promise<ResendDigestResponseDto> {
    const email = recipient.toLowerCase();
    const user = await this.users
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .where('LOWER(u.email) = :email', { email })
      .getRawOne<{ id: string }>();
    if (!user) {
      throw new NotFoundException('No user found for that recipient address');
    }

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    await this.jobs.enqueueDigestResend({
      user_id: user.id,
      // Unique per click → the resend never dedups against the failed weekly job.
      for_local_window: `resend-${windowEnd.getTime()}`,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
    });
    return { status: 'queued', user_id: user.id };
  }

  async list(
    query: ListAdminEmailLogQueryDto,
  ): Promise<AdminEmailLogListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const qb = this.emailLog
      .createQueryBuilder('e')
      .orderBy('e.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status) {
      qb.andWhere('e.status = :status', { status: query.status });
    }
    if (query.tag) {
      qb.andWhere('e.tag = :tag', { tag: query.tag });
    }
    if (query.recipient) {
      // Exact match on the lowercased address (recipients are stored lowercased)
      // so the (recipient, created_at) index is used. A leading-wildcard ILIKE
      // would full-scan this append-only, ever-growing table on every lookup.
      qb.andWhere('e.recipient = :recipient', {
        recipient: query.recipient.toLowerCase(),
      });
    }

    const [rows, total] = await qb.getManyAndCount();

    return { rows: rows.map((r) => this.toRow(r)), total, page, pageSize };
  }

  private toRow(e: EmailLog): AdminEmailLogRowDto {
    return {
      id: e.id,
      recipient: e.recipient,
      tag: e.tag,
      subject: e.subject,
      status: e.status,
      provider: e.provider,
      provider_message_id: e.provider_message_id,
      error_class: e.error_class,
      created_at: e.created_at.toISOString(),
    };
  }
}

interface SampleDigestContext {
  displayName: string;
  rideCount: number;
  totalKm: number;
  totalMinutes: number;
  bestQuality: number;
  percentExplored: number;
  riddenSegments: number;
  units: UnitSystem;
  exploreUrl: string;
}

/** Fixed, representative content for a test digest preview. */
function sampleDigestContext(exploreUrl: string): SampleDigestContext {
  return {
    displayName: 'Rider',
    rideCount: 4,
    totalKm: 213.7,
    totalMinutes: 372,
    bestQuality: 4.2,
    percentExplored: 38,
    riddenSegments: 512,
    units: 'metric',
    exploreUrl,
  };
}
