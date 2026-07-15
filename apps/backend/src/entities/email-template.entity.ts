import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EmailBlock, SupportedLocale } from '@tarmoto/shared';

/**
 * Admin-authored override for a code-owned email template (admin email
 * template editor, Phase 1). Versioned: at most one `published` row per
 * `(template_tag, locale)` is the active override, enforced by the partial
 * unique index below; `draft` rows are unconstrained scratch copies.
 * `version` and the full draft/publish workflow (history, revert,
 * reset-to-default) are Phase 3 — this schema carries the columns so Phase 3
 * needs no migration, but Phase 1 only ever reads the single published row.
 * See docs/superpowers/specs/2026-07-14-admin-email-template-editor-phase1-design.md
 */
@Entity('email_template')
// At most one published override per (tag, locale); drafts are unconstrained.
@Index('uq_email_template_published', ['template_tag', 'locale'], {
  unique: true,
  where: "status = 'published'",
})
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** One of the editable tags — validated in code against the editable set. */
  @Column({ type: 'varchar', length: 64 })
  template_tag!: string;

  @Column({ type: 'varchar', length: 10 })
  locale!: SupportedLocale;

  /** Plain text + whitelisted `{var}` placeholders — no HTML. */
  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'jsonb' })
  blocks!: EmailBlock[];

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: 'draft' | 'published' | 'archived';

  /** Monotonic per (template_tag, locale). */
  @Column({ type: 'int', default: 1 })
  version!: number;

  /** Admin user id; nullable for seed/system-authored rows. */
  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  published_at!: Date | null;
}
