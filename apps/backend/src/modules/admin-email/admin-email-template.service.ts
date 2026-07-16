import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import type { SupportedLocale } from '@tarmoto/shared';
import { AdminUser } from '../../entities/admin-user.entity.js';
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
import { DEFAULT_TEMPLATE_BLOCKS } from './default-template-blocks.js';
import type {
  EmailTemplateDetailDto,
  EmailTemplateSummaryDto,
  EmailTemplateVersionDto,
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
      where: {
        template_tag: In([...EDITABLE_TAGS]),
        status: In(['draft', 'published']),
      },
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

  /** The draft row if one exists, else the published row, else the tag's
   *  default block document seeded in as a starting point. */
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
    if (row) return this.toDetail(tag, locale, row);
    // No override yet — seed the editor from the tag's default block document
    // instead of a blank starter. Still status:'none'/version:0: nothing is
    // published, the code template keeps rendering until the admin publishes.
    const seed = DEFAULT_TEMPLATE_BLOCKS[tag];
    return {
      tag,
      locale,
      subject: seed.subject,
      blocks: seed.blocks,
      status: 'none',
      version: 0,
      whitelist: TEMPLATE_WHITELIST[tag],
    };
  }

  /** Validates then upserts the single draft row for (tag, locale), serialized
   *  under the (tag, locale) advisory lock so two concurrent first-saves can't
   *  both insert a draft (there is no unique index on draft rows). `actorId` is
   *  recorded on a freshly inserted draft. */
  async saveDraft(
    tag: string,
    locale: SupportedLocale,
    dto: SaveDraftDto,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const result = validateBlockDocument(tag, dto);
    if (!result.ok) throw new BadRequestException(result.errors);

    await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      // Targeted UPDATE ... WHERE status='draft' carrying only subject/blocks,
      // so a row a super_admin published between our read and write is never
      // reverted to draft; if nothing matched, insert a fresh draft.
      const updated = await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'draft' },
        { subject: result.doc.subject, blocks: result.doc.blocks },
      );
      if (!updated.affected) {
        await m.save(
          m.create(EmailTemplate, {
            template_tag: tag,
            locale,
            subject: result.doc.subject,
            blocks: result.doc.blocks,
            status: 'draft',
            created_by: actorId,
          }),
        );
      }
    });

    const row = await this.templates.findOne({
      where: { template_tag: tag, locale, status: 'draft' },
    });
    return this.toDetail(tag, locale, row);
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
   * Acquire a transaction-scoped Postgres advisory lock serializing the
   * mutations for one (tag, locale). publish and reset both act on the single
   * published row — one promotes a draft into it, the other deletes it — but
   * observe/target it in separate transactions, so without a shared lock a
   * reset can overlap a publish and miss the row it commits. An advisory lock
   * rather than a row lock, because the row is being created/deleted so there
   * is no stable row to lock; keyed on a stable hash of (tag, locale) and
   * released automatically at commit/rollback.
   */
  private async lockTemplate(
    m: EntityManager,
    tag: string,
    locale: SupportedLocale,
  ): Promise<void> {
    await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `email_template:${tag}:${locale}`,
    ]);
  }

  /** Monotonic next version for (tag, locale): one past the highest existing
   *  published-or-archived version. Collision-free even after a reset (which
   *  archives, not deletes, the published row), because the archived row
   *  keeps its number and is counted here too. First-ever publish → 1. */
  private async nextVersion(
    m: EntityManager,
    tag: string,
    locale: SupportedLocale,
  ): Promise<number> {
    const top = await m.findOne(EmailTemplate, {
      where: {
        template_tag: tag,
        locale,
        status: In(['published', 'archived']),
      },
      order: { version: 'DESC' },
    });
    return (top?.version ?? 0) + 1;
  }

  /**
   * Promotes the draft to published, atomically, keeping the prior published
   * row as history. The archive-old + promote-draft MUST run in one
   * transaction, and the archive MUST precede the promote, or the partial
   * unique index (<=1 published per (tag, locale)) rejects two momentary
   * published rows. `actorId` (the publishing admin) is recorded as the
   * version's author.
   */
  async publish(
    tag: string,
    locale: SupportedLocale,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const saved = await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      const draft = await m.findOne(EmailTemplate, {
        where: { template_tag: tag, locale, status: 'draft' },
        // Lock the draft row for the promotion. Without it a concurrent
        // saveDraft UPDATE could land between this read and the m.save below,
        // and the stale in-memory entity we promote would overwrite those newer
        // subject/blocks — losing the edit with no draft copy left. FOR UPDATE
        // makes that save wait until we commit; it then sees the row published
        // and creates a fresh draft instead. (EmailTemplate has no relations,
        // so there is no join to trip the PG "FOR UPDATE on outer join" error.)
        lock: { mode: 'pessimistic_write' },
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
      const version = await this.nextVersion(m, tag, locale);
      // Archive the current published row (if any) BEFORE promoting the draft.
      await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'published' },
        { status: 'archived' },
      );
      draft.status = 'published';
      draft.version = version;
      draft.created_by = actorId;
      draft.published_at = new Date();
      return m.save(draft);
    });
    return this.toDetail(tag, locale, saved);
  }

  /** Archives the published override for (tag, locale) instead of deleting it:
   *  the code template renders again once there is no published row, but the
   *  version stays in history and stays revertable, and its number is never
   *  reused by a later publish. Idempotent. */
  async reset(tag: string, locale: SupportedLocale): Promise<void> {
    this.assertEditable(tag);
    await this.dataSource.transaction(async (m) => {
      // Serialize with publish under the same advisory lock. Otherwise a reset
      // overlapping a publish runs its archive UPDATE against a snapshot where
      // the promote is still uncommitted, returns 200, and leaves the
      // just-published override live. Under the lock, reset waits for the
      // publish to commit and then archives the row it created.
      await this.lockTemplate(m, tag, locale);
      // Archive the live override instead of deleting it: the code template
      // renders again (no published row), but the version stays in history and
      // remains revertable, and its number is never reused by a later publish.
      await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'published' },
        { status: 'archived' },
      );
    });
  }

  /** Published + archived versions for (tag, locale), newest first, with each
   *  version's publisher resolved to an email in one batched admin_users
   *  lookup (no N+1). Content is included so the admin can preview any version. */
  async history(
    tag: string,
    locale: SupportedLocale,
  ): Promise<EmailTemplateVersionDto[]> {
    this.assertEditable(tag);
    const rows = await this.templates.find({
      where: {
        template_tag: tag,
        locale,
        status: In(['published', 'archived']),
      },
      order: { version: 'DESC' },
    });
    const ids = [
      ...new Set(
        rows.map((r) => r.created_by).filter((id): id is string => id != null),
      ),
    ];
    const emailById = new Map<string, string>();
    if (ids.length > 0) {
      const admins = await this.templates.manager.find(AdminUser, {
        where: { id: In(ids) },
        select: { id: true, email: true },
      });
      for (const a of admins) emailById.set(a.id, a.email);
    }
    return rows.map((r) => ({
      version: r.version,
      status: r.status as 'published' | 'archived',
      author: r.created_by ? (emailById.get(r.created_by) ?? null) : null,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      subject: r.subject,
      blocks: r.blocks,
    }));
  }

  /** Rolls back to a prior version by re-publishing its content as a NEW
   *  version (audited to the acting admin). The target content is re-read from
   *  the DB and re-validated — never trusted from the client — and the current
   *  published row is archived first (partial unique index). The original
   *  target row stays as history; an existing draft is left untouched. */
  async revert(
    tag: string,
    locale: SupportedLocale,
    version: number,
    actorId: string | null = null,
  ): Promise<EmailTemplateDetailDto> {
    this.assertEditable(tag);
    const saved = await this.dataSource.transaction(async (m) => {
      await this.lockTemplate(m, tag, locale);
      const target = await m.findOne(EmailTemplate, {
        where: {
          template_tag: tag,
          locale,
          version,
          status: In(['published', 'archived']),
        },
      });
      if (!target) {
        throw new NotFoundException(
          `No version ${version} for ${tag}/${locale}`,
        );
      }
      // Reverting to the version that is already live is a no-op: it would
      // archive the live row and re-publish identical content as a new version,
      // polluting the audit history with a spurious entry. Reject it (the admin
      // drawer also hides Revert on the live row, so this guards direct calls).
      if (target.status === 'published') {
        throw new BadRequestException(
          `Version ${version} is already the live version — nothing to revert.`,
        );
      }
      const check = validateBlockDocument(tag, {
        subject: target.subject,
        blocks: target.blocks,
      });
      if (!check.ok) {
        throw new BadRequestException(check.errors);
      }
      const next = await this.nextVersion(m, tag, locale);
      await m.update(
        EmailTemplate,
        { template_tag: tag, locale, status: 'published' },
        { status: 'archived' },
      );
      const row = m.create(EmailTemplate, {
        template_tag: tag,
        locale,
        subject: target.subject,
        blocks: target.blocks,
        status: 'published',
        version: next,
        created_by: actorId,
        published_at: new Date(),
      });
      return m.save(row);
    });
    return this.toDetail(tag, locale, saved);
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
      // toDetail only ever receives a draft or published row (publish/revert
      // return the promoted row; get/saveDraft read draft-or-published), never
      // an archived one — narrow the widened column type to the DTO's set.
      status: row.status as 'draft' | 'published',
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
