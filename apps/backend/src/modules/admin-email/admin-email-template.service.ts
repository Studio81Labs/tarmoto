import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { SupportedLocale } from '@tarmoto/shared';
import { EmailTemplate } from '../../entities/email-template.entity.js';
import { EmailService } from '../email/email.service.js';
import {
  EDITABLE_TAGS,
  TEMPLATE_WHITELIST,
  type EditableTag,
} from '../email/presentation/index.js';
import { renderBlocks } from '../email/render/render-blocks.js';
import { SAMPLE_PRESENTATION } from '../email/render/sample-presentation.js';
import { validateBlockDocument } from '../email/render/validate-block-document.js';
import type {
  EmailTemplateDetailDto,
  EmailTemplateSummaryDto,
  PreviewRequestDto,
  PreviewResponseDto,
  SaveDraftDto,
} from './dto/admin-email-template.dto.js';

/** Human-readable label per editable tag, for the admin template list. */
const TAG_LABELS: Record<EditableTag, string> = {
  'weekly-digest': 'Weekly digest',
  'subscription-confirmed': 'Subscription confirmed',
  'subscription-cancelled': 'Subscription cancelled',
  'data-export-ready': 'Data export ready',
  'account-deletion-scheduled': 'Account deletion scheduled',
  'account-deletion-completed': 'Account deletion completed',
};

/**
 * Service layer for the admin email-template editor (Phase 2a): list, get,
 * saveDraft, preview, testSend, publish, and reset over the `email_template`
 * table for the 6 editable tags. `preview`/`testSend` render through the same
 * Phase-1 code-owned `renderBlocks` that `EmailService`'s send-time override
 * lookup uses, so a preview is byte-for-byte what a real send would produce
 * for the same document. Role enforcement (`support` vs `super_admin`) is a
 * controller concern (Task 5), not this service's.
 * See docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase2a-api-design.md
 */
@Injectable()
export class AdminEmailTemplateService {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
    private readonly dataSource: DataSource,
    private readonly email: EmailService,
  ) {}

  /** Per-tag hasDraft/hasPublished summary for the editor's landing list — one query, no N+1. */
  async list(): Promise<EmailTemplateSummaryDto[]> {
    const rows = await this.templates.find({
      select: { template_tag: true, status: true },
      where: { template_tag: In([...EDITABLE_TAGS]) },
    });
    const drafts = new Set(
      rows.filter((r) => r.status === 'draft').map((r) => r.template_tag),
    );
    const published = new Set(
      rows.filter((r) => r.status === 'published').map((r) => r.template_tag),
    );
    return EDITABLE_TAGS.map((tag) => ({
      tag,
      label: TAG_LABELS[tag],
      hasDraft: drafts.has(tag),
      hasPublished: published.has(tag),
      legalSensitive: tag.startsWith('account-deletion'),
    }));
  }

  /** The draft row if one exists, else the published row, else an empty starter. */
  async get(
    tag: string,
    locale: SupportedLocale,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const draft = await this.templates.findOne({
      where: { template_tag: tag, locale, status: 'draft' },
    });
    const row =
      draft ??
      (await this.templates.findOne({
        where: { template_tag: tag, locale, status: 'published' },
      }));
    return this.toDetail(tag, locale, row);
  }

  /** Validates then upserts the single draft row for (tag, locale). */
  async saveDraft(
    tag: string,
    locale: SupportedLocale,
    dto: SaveDraftDto,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const result = validateBlockDocument(tag, dto);
    if (!result.ok) throw new BadRequestException(result.errors);

    const existing = await this.templates.findOne({
      where: { template_tag: tag, locale, status: 'draft' },
    });
    let row: EmailTemplate;
    if (existing) {
      existing.subject = result.doc.subject;
      existing.blocks = result.doc.blocks;
      row = existing;
    } else {
      row = this.templates.create({
        template_tag: tag,
        locale,
        subject: result.doc.subject,
        blocks: result.doc.blocks,
        status: 'draft',
      });
    }
    const saved = await this.templates.save(row);
    return this.toDetail(tag, locale, saved);
  }

  /** Validates and renders the supplied doc against fixed sample data — no persistence.
   *  Stays `async` (though `validateAndRender` itself is synchronous) so an invalid doc
   *  or a locked tag surfaces as a rejected promise, matching every other public method
   *  here rather than a same-tick throw. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async preview(
    tag: string,
    locale: SupportedLocale,
    dto: PreviewRequestDto,
  ): Promise<PreviewResponseDto> {
    this.assertEditable(tag);
    return this.validateAndRender(tag, locale, dto);
  }

  /** Same render as preview, dispatched to `toEmail` (the requesting admin's own address). */
  async testSend(
    tag: string,
    locale: SupportedLocale,
    dto: PreviewRequestDto,
    toEmail: string,
  ): Promise<{ status: 'sent' | 'failed' }> {
    this.assertEditable(tag);
    const rendered = this.validateAndRender(tag, locale, dto);
    const result = await this.email.sendRendered(toEmail, {
      ...rendered,
      tag,
    });
    return { status: result ? 'sent' : 'failed' };
  }

  /**
   * Promotes the draft row to published, atomically. The delete-old-published
   * + promote-draft MUST run in one transaction, or the partial unique index
   * (at most one `published` row per (tag, locale)) rejects the promote when
   * a reader would otherwise briefly see two published rows.
   */
  async publish(
    tag: string,
    locale: SupportedLocale,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const saved = await this.dataSource.transaction(async (m) => {
      const draft = await m.findOne(EmailTemplate, {
        where: { template_tag: tag, locale, status: 'draft' },
      });
      if (!draft) {
        throw new NotFoundException(`No draft to publish for ${tag}/${locale}`);
      }
      // Publish is the safety gate, so re-validate the stored draft before it
      // goes live. Drafts are normally validated at save time, but re-checking
      // here rejects any written out-of-band or under since-tightened rules —
      // and the subject's control-char/whitelist rules are NOT re-enforced at
      // render time (the subject is interpolated raw into a plain-text header,
      // so a CRLF there would otherwise reach the mail provider unchecked).
      const check = validateBlockDocument(tag, {
        subject: draft.subject,
        blocks: draft.blocks,
      });
      if (!check.ok) {
        throw new BadRequestException(check.errors);
      }
      const priorPublished = await m.findOne(EmailTemplate, {
        where: { template_tag: tag, locale, status: 'published' },
      });
      await m.delete(EmailTemplate, {
        template_tag: tag,
        locale,
        status: 'published',
      });
      draft.status = 'published';
      // Monotonic per (tag, locale): continue from the prior published version, not
      // the fresh draft's default. First publish (no prior) → 2; each later publish
      // increments the last published version.
      draft.version = (priorPublished?.version ?? draft.version) + 1;
      draft.published_at = new Date();
      return m.save(draft);
    });
    return this.toDetail(tag, locale, saved);
  }

  /** Deletes the published override for (tag, locale) — the code template renders again. Idempotent. */
  async reset(tag: string, locale: SupportedLocale): Promise<void> {
    this.assertEditable(tag);
    await this.templates.delete({
      template_tag: tag,
      locale,
      status: 'published',
    });
  }

  /** Rejects any tag outside the 6 editable ones — locked tags 404 everywhere, per spec. */
  private assertEditable(tag: string): asserts tag is EditableTag {
    if (!(EDITABLE_TAGS as readonly string[]).includes(tag)) {
      throw new NotFoundException(
        `Unknown or non-editable template tag: ${tag}`,
      );
    }
  }

  /** `version: 0` is the deliberate "never saved" sentinel for the empty starter;
   *  real rows use their own `version`, which starts at the entity default 1. */
  private toDetail(
    tag: EditableTag,
    locale: SupportedLocale,
    row: EmailTemplate | null,
  ): EmailTemplateDetailDto {
    const whitelist = TEMPLATE_WHITELIST[tag];
    if (!row) {
      return {
        tag,
        locale,
        subject: '',
        blocks: [],
        status: 'none',
        version: 0,
        whitelist,
      };
    }
    return {
      tag,
      locale,
      subject: row.subject,
      blocks: row.blocks,
      status: row.status,
      version: row.version,
      whitelist,
    };
  }

  /** Shared validate-then-render for preview/testSend — reuses the exact
   *  code-owned renderer the send-time override lookup uses, against fixed
   *  sample presentation data, so a preview is byte-for-byte what a real
   *  send would produce for the same document. */
  private validateAndRender(
    tag: EditableTag,
    locale: SupportedLocale,
    dto: SaveDraftDto | PreviewRequestDto,
  ): PreviewResponseDto {
    const result = validateBlockDocument(tag, dto);
    if (!result.ok) throw new BadRequestException(result.errors);
    const { subject, html, text } = renderBlocks(
      result.doc,
      SAMPLE_PRESENTATION[tag],
      {
        locale,
        preferencesUrl: this.email.resolvePreferencesUrl(),
        marketingFooter: tag === 'weekly-digest',
      },
    );
    return { subject, html, text };
  }
}
