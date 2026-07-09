import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailLog } from '../../entities/email-log.entity.js';
import {
  AdminEmailLogListResponseDto,
  AdminEmailLogRowDto,
  ListAdminEmailLogQueryDto,
} from './dto/admin-email.dto.js';

@Injectable()
export class AdminEmailService {
  constructor(
    @InjectRepository(EmailLog)
    private readonly emailLog: Repository<EmailLog>,
  ) {}

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
