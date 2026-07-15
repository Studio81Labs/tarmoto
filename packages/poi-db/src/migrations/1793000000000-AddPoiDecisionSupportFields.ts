import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #848 — widen `pois` with decision-support fields captured from OSM.
 *
 * The store previously kept only name / website / phone / kind / geom. Riders
 * deciding "is this the right restaurant / fuel / hotel?" also need opening
 * hours, an address, cuisine / brand, and (for hotels) a star class. We also
 * add a bounded raw `tags` JSONB bag so later phases can derive new fields
 * without a re-import, and reserved commercial-match id columns
 * (`google_place_id` / `fsq_id`) for the on-demand enrichment layer (#851) —
 * only the ids are ever persisted; ratings / photos are fetched at view time.
 *
 * All columns are nullable (OSM tag coverage is uneven) so this is an additive,
 * non-blocking change on the existing table. GIN on `tags` supports future tag
 * filtering; `(address_country, kind)` supports country + category browse (#849).
 */
export class AddPoiDecisionSupportFields1793000000000 implements MigrationInterface {
  name = "AddPoiDecisionSupportFields1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE pois
        ADD COLUMN opening_hours VARCHAR(512),
        ADD COLUMN address_street VARCHAR(255),
        ADD COLUMN address_city VARCHAR(128),
        ADD COLUMN address_postcode VARCHAR(32),
        ADD COLUMN address_country VARCHAR(2),
        ADD COLUMN cuisine VARCHAR(128),
        ADD COLUMN brand VARCHAR(128),
        ADD COLUMN stars SMALLINT,
        ADD COLUMN tags JSONB,
        ADD COLUMN google_place_id VARCHAR(128),
        ADD COLUMN fsq_id VARCHAR(64),
        ADD COLUMN enrichment_matched_at TIMESTAMPTZ;

      -- jsonb_path_ops is the smaller, faster GIN operator class for the
      -- containment (@>) queries a tag filter uses.
      CREATE INDEX idx_pois_tags ON pois USING GIN (tags jsonb_path_ops);
      CREATE INDEX idx_pois_country_kind ON pois (address_country, kind);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_pois_country_kind;
      DROP INDEX IF EXISTS idx_pois_tags;

      ALTER TABLE pois
        DROP COLUMN IF EXISTS enrichment_matched_at,
        DROP COLUMN IF EXISTS fsq_id,
        DROP COLUMN IF EXISTS google_place_id,
        DROP COLUMN IF EXISTS tags,
        DROP COLUMN IF EXISTS stars,
        DROP COLUMN IF EXISTS brand,
        DROP COLUMN IF EXISTS cuisine,
        DROP COLUMN IF EXISTS address_country,
        DROP COLUMN IF EXISTS address_postcode,
        DROP COLUMN IF EXISTS address_city,
        DROP COLUMN IF EXISTS address_street,
        DROP COLUMN IF EXISTS opening_hours;
    `);
  }
}
