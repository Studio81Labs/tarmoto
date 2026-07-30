import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * Tracks managed hazard-photo files that have been uploaded (via
 * `POST /hazards/photos`) but not yet attached to a hazard report. A row is
 * inserted when the file is written and DELETED the moment a report claims it,
 * so the table holds only *pending* uploads.
 *
 * This is what makes orphan reclamation bounded and origin-independent: the
 * hourly sweep queries `WHERE uploaded_at < cutoff` on the indexed timestamp
 * — returning only the (few) genuinely-stranded uploads — instead of scanning
 * every photo-bearing hazard row and the whole uploads directory, and it keys
 * on the stored filename so a change to `TARMOTO_PUBLIC_BASE_URL` can't hide a
 * still-referenced file.
 */
@Entity('hazard_photo_uploads')
@Index('idx_hazard_photo_uploads_uploaded_at', ['uploaded_at'])
// Backs the per-user pending-upload quota check in `uploadPhoto`.
@Index('idx_hazard_photo_uploads_user_id', ['user_id'])
export class HazardPhotoUpload {
  /** The managed on-disk filename (unique). */
  @PrimaryColumn({ type: 'text' })
  filename!: string;

  /** The owner — retained for auditing; sweeps key on `uploaded_at`. */
  @Column({ type: 'uuid' })
  user_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  uploaded_at!: Date;
}
