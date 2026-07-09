import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type EmailLogStatus = 'sent' | 'failed';

/**
 * Append-only delivery log for outbound email — one row per send attempt,
 * written best-effort from `EmailService.dispatch`. METADATA ONLY: recipient,
 * template tag, subject, status, provider, and the provider's message id (or a
 * short error on failure). The rendered body is DELIBERATELY never stored —
 * verification / reset templates embed live one-time tokens, so persisting
 * bodies would turn the log into a credential-takeover surface (the same reason
 * `dispatch` redacts bodies from failure logs).
 *
 * Keyed on `recipient` (lowercased) rather than a user FK: the dispatch layer
 * only has the destination address, some recipients aren't users (external trip
 * invites), and recipient email is what drives the admin view, the GDPR export,
 * and the deletion purge.
 */
@Entity('email_log')
@Index('idx_email_log_recipient_created', ['recipient', 'created_at'])
@Index('idx_email_log_created', ['created_at'])
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Destination address, lowercased so purge / export match by user email. */
  @Column({ type: 'varchar', length: 255 })
  recipient!: string;

  /**
   * Template tag (see `EmailTag`). Kept as a free string so a new template
   * doesn't force an entity/migration change.
   */
  @Column({ type: 'varchar', length: 64 })
  tag!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: EmailLogStatus;

  /** Provider that handled (or was attempted for) the send, e.g. 'resend'. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  provider!: string | null;

  /** Provider message id — present only on a successful send. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  provider_message_id!: string | null;

  /** Short error string captured on a failed send (never the body). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  error_class!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
