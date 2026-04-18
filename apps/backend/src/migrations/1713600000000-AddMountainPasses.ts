import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-11 — seasonal pass availability data.
 *
 * Adds the `mountain_passes` table plus a seed of well-known Alpine and
 * Czech/Slovak passes so the feature has data on first boot. The seed
 * uses a single multi-row INSERT to keep this idempotent-ish: re-running
 * the migration in a fresh DB always lands the same baseline.
 */
export class AddMountainPasses1713600000000 implements MigrationInterface {
  name = 'AddMountainPasses1713600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mountain_passes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL,
        country_code VARCHAR(2) NOT NULL,
        region VARCHAR(120),
        location GEOMETRY(Point, 4326) NOT NULL,
        elevation_m INT NOT NULL,
        typical_open_month SMALLINT NOT NULL CHECK (typical_open_month BETWEEN 1 AND 12),
        typical_close_month SMALLINT NOT NULL CHECK (typical_close_month BETWEEN 1 AND 12),
        override_status VARCHAR(10) CHECK (override_status IN ('open', 'closed', 'unknown')),
        notes TEXT,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_mountain_passes_location ON mountain_passes USING GIST (location);
      CREATE INDEX idx_mountain_passes_country ON mountain_passes (country_code);
    `);

    await queryRunner.query(`
      INSERT INTO mountain_passes
        (name, country_code, region, location, elevation_m, typical_open_month, typical_close_month, notes)
      VALUES
        ('Stelvio Pass', 'IT', 'Lombardy', ST_SetSRID(ST_MakePoint(10.4540, 46.5285), 4326), 2757, 6, 10,
          'Italy''s second-highest paved pass; classic 48-hairpin climb.'),
        ('Grossglockner High Alpine Road', 'AT', 'Carinthia/Salzburg', ST_SetSRID(ST_MakePoint(12.8267, 47.0744), 4326), 2504, 5, 10,
          'Toll road; gates close at night even in season.'),
        ('Furka Pass', 'CH', 'Uri/Valais', ST_SetSRID(ST_MakePoint(8.4156, 46.5723), 4326), 2429, 6, 10,
          'Featured in the 1964 Bond film; spectacular Rhone glacier views.'),
        ('Gotthard Pass (Tremola)', 'CH', 'Ticino', ST_SetSRID(ST_MakePoint(8.5664, 46.5586), 4326), 2106, 5, 10,
          'Cobblestone Tremola road on south side; tunnel alternative year-round.'),
        ('San Bernardino Pass', 'CH', 'Graubünden', ST_SetSRID(ST_MakePoint(9.1728, 46.4944), 4326), 2066, 5, 10,
          'Closes early after first heavy snow; tunnel below stays open.'),
        ('Col du Galibier', 'FR', 'Hautes-Alpes', ST_SetSRID(ST_MakePoint(6.4078, 45.0639), 4326), 2642, 6, 10,
          'Often used in Tour de France; tunnel bypasses summit when closed.'),
        ('Col d''Iseran', 'FR', 'Savoie', ST_SetSRID(ST_MakePoint(7.0306, 45.4172), 4326), 2770, 7, 9,
          'Highest paved pass in the Alps; very short rideable season.'),
        ('Timmelsjoch / Passo Rombo', 'AT', 'Tyrol/South Tyrol', ST_SetSRID(ST_MakePoint(11.0967, 46.9094), 4326), 2509, 6, 10,
          'Toll road; closed at night; Austrian/Italian border.'),
        ('Pordoi Pass', 'IT', 'Trentino/Veneto', ST_SetSRID(ST_MakePoint(11.8128, 46.4878), 4326), 2239, 5, 11,
          'Dolomites; usually first to open and last to close in the region.'),
        ('Ovčiarsky Vrch (Donovaly)', 'SK', 'Banská Bystrica', ST_SetSRID(ST_MakePoint(19.2225, 48.8775), 4326), 960, 1, 12,
          'Open year-round but expect winter conditions Nov–Mar.'),
        ('Červenohorské sedlo', 'CZ', 'Olomouc/Moravian-Silesian', ST_SetSRID(ST_MakePoint(17.1242, 50.1125), 4326), 1013, 1, 12,
          'Jeseníky pass on road 44; open year-round with frequent winter closures.');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS mountain_passes CASCADE`);
  }
}
