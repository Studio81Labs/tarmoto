import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminConsoleFoundation1751000000000 implements MigrationInterface {
  name = 'AddAdminConsoleFoundation1751000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE admin_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(20) NOT NULL DEFAULT 'read_only',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        sso_provider VARCHAR(32),
        sso_subject VARCHAR(255),
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_admin_users_email ON admin_users (email);
      CREATE UNIQUE INDEX uq_admin_users_sso ON admin_users (sso_provider, sso_subject)
        WHERE sso_provider IS NOT NULL AND sso_subject IS NOT NULL;
      CREATE INDEX idx_admin_users_role_status ON admin_users (role, status);

      CREATE TABLE admin_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_admin_sessions_user ON admin_sessions (admin_user_id);

      CREATE TABLE admin_refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        replaced_by_token_id UUID,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_admin_refresh_token_hash ON admin_refresh_tokens (token_hash);
      CREATE INDEX idx_admin_refresh_session ON admin_refresh_tokens (session_id);

      CREATE TABLE admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id UUID,
        admin_role VARCHAR(20),
        event_key VARCHAR(64) NOT NULL,
        outcome VARCHAR(16) NOT NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(512) NOT NULL,
        target_type VARCHAR(64),
        target_id VARCHAR(128),
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_admin_audit_created ON admin_audit_logs (created_at);
      CREATE INDEX idx_admin_audit_actor ON admin_audit_logs (admin_user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS admin_audit_logs CASCADE;
      DROP TABLE IF EXISTS admin_refresh_tokens CASCADE;
      DROP TABLE IF EXISTS admin_sessions CASCADE;
      DROP TABLE IF EXISTS admin_users CASCADE;
    `);
  }
}
