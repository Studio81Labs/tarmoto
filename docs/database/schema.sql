-- Tarmoto Database Schema
-- PostgreSQL 16+ with PostGIS extension
-- Generated: April 2026

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS & AUTH
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    display_name    VARCHAR(100) NOT NULL,
    phone           VARCHAR(20),
    home_location   GEOMETRY(Point, 4326),
    work_location   GEOMETRY(Point, 4326),
    preferences     JSONB DEFAULT '{}',
    -- preferences: { daily_km: 250, min_quality: 3.5, road_types: ["curvy","scenic"], units: "metric" }
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    phone           VARCHAR(20) NOT NULL,
    is_emergency    BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_contacts_user ON user_contacts(user_id);

-- ============================================================
-- ROAD SEGMENTS (core data model)
-- ============================================================

CREATE TABLE road_segments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    geom            GEOMETRY(LineString, 4326) NOT NULL,
    length_m        FLOAT NOT NULL,
    road_name       VARCHAR(255),
    road_number     VARCHAR(50),
    curviness_score FLOAT DEFAULT 0,         -- 0-5, computed from geometry
    quality_score   FLOAT,                   -- 1-5, aggregated from readings
    osm_quality_seed FLOAT,                  -- 1-5, OSM-derived prior blended into quality_score
    quality_source  VARCHAR(20),             -- osm_smoothness, osm_surface, or osm_highway
    surface_type    VARCHAR(30) DEFAULT 'unknown',  -- asphalt, concrete, cobblestone, gravel, dirt
    surface_from_reading BOOLEAN NOT NULL DEFAULT false, -- #796: true once a rider classifies the surface; durable (survives location_retention sweep) so the OSM importer refreshes the seed only while false
    reading_count   INT DEFAULT 0,           -- number of rider passes (post-filter)
    confidence      INT DEFAULT 0,           -- 0-100, increases with more readings
    last_filtered_count INT NOT NULL DEFAULT 0, -- #495: rows dropped as >2σ outliers on the latest aggregation run
    elevation_min   FLOAT,
    elevation_max   FLOAT,
    last_updated    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_road_segments_geom ON road_segments USING GIST(geom);
CREATE INDEX idx_road_segments_quality ON road_segments(quality_score);
CREATE INDEX idx_road_segments_curviness ON road_segments(curviness_score);

-- ============================================================
-- SURFACE READINGS (accelerometer data from rides)
-- ============================================================

CREATE TABLE surface_readings (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    road_segment_id          UUID NOT NULL REFERENCES road_segments(id),
    ride_id                  UUID,  -- FK added after rides table
    -- US-62: anonymized road-quality data is retained on account deletion;
    -- the user_id FK is SET NULL so contributions stay in the community dataset.
    user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
    iri_value                FLOAT NOT NULL,          -- International Roughness Index
    classification           VARCHAR(20) NOT NULL,    -- excellent, good, fair, poor, very_poor
    surface_type             VARCHAR(30),
    vibration_rms            FLOAT,                   -- root mean square of accelerometer
    speed_at_reading         FLOAT,                   -- km/h, for calibration
    device_model             VARCHAR(100),            -- phone model for ML calibration
    -- Issue #494: coarse five-bucket family encoding of `device_model`
    -- (`iphone_pro` / `iphone_standard` / `pixel` / `samsung_galaxy_s` /
    -- `other`). Stored alongside the raw model string so training queries
    -- group by family without re-running the encoder over historical data.
    device_family            VARCHAR(32),
    -- Issue #494: 'good' / 'poor' classification of the upload's
    -- idle-baseline calibration block (or NULL when the upload omitted
    -- one). Aggregations can down-weight or drop rows tagged 'poor'.
    calibration_quality      VARCHAR(8),
    -- Issue #3 (US-3): on-device classifier identifier (telemetry only).
    client_model_version     VARCHAR(32),
    -- Issue #493: on-device sensor-preprocessing identifier (telemetry only).
    client_preprocessing_version VARCHAR(32),
    -- Research issue #7: rider-asserted surface label resolved from the
    -- active ride's tag events at this reading's window timestamp.
    rider_surface_label      VARCHAR(32),
    rider_quality_label      VARCHAR(20),
    recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_surface_readings_segment ON surface_readings(road_segment_id);
CREATE INDEX idx_surface_readings_time ON surface_readings(recorded_at DESC);
-- Partial indexes — most rows are NULL on these telemetry columns;
-- keep the btree small and only index populated rows so training
-- queries that filter by family / classifier / preprocessing /
-- calibration quality don't pay for a full scan.
CREATE INDEX idx_surface_readings_device_family
    ON surface_readings(device_family)
    WHERE device_family IS NOT NULL;
CREATE INDEX idx_surface_readings_calibration_quality
    ON surface_readings(calibration_quality)
    WHERE calibration_quality IS NOT NULL;
CREATE INDEX idx_surface_readings_client_model_version
    ON surface_readings(client_model_version)
    WHERE client_model_version IS NOT NULL;
CREATE INDEX idx_surface_readings_client_preprocessing_version
    ON surface_readings(client_preprocessing_version)
    WHERE client_preprocessing_version IS NOT NULL;
CREATE INDEX idx_surface_readings_rider_label
    ON surface_readings(rider_surface_label)
    WHERE rider_surface_label IS NOT NULL;

-- ============================================================
-- RIDES & TRACKING
-- ============================================================

CREATE TABLE rides (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at                  TIMESTAMPTZ NOT NULL,
    ended_at                    TIMESTAMPTZ,
    distance_km                 FLOAT,
    avg_speed                   FLOAT,
    max_speed                   FLOAT,
    route_geom                  GEOMETRY(LineString, 4326),
    avg_road_quality            FLOAT,
    avg_curviness               FLOAT,
    ride_type                   VARCHAR(20) DEFAULT 'free', -- free, commute, trip, tracked
    name                        VARCHAR(120),
    status                      VARCHAR(20) DEFAULT 'active', -- active, completed, cancelled
    bike_id                     UUID,
    -- Issue #494: idle-baseline calibration captured at ride start
    -- (~30 s of stationary samples). Per-axis mean / std are persisted
    -- once per ride (first-write-wins; concurrent batches don't clobber)
    -- so the training pipeline can subtract per-rider bias from raw
    -- samples. NULL when the rider's calibration window was abandoned
    -- (sub-floor sample count or non-stationary capture).
    calibration_axis_mean_x     DOUBLE PRECISION,
    calibration_axis_mean_y     DOUBLE PRECISION,
    calibration_axis_mean_z     DOUBLE PRECISION,
    calibration_axis_std_x      DOUBLE PRECISION,
    calibration_axis_std_y      DOUBLE PRECISION,
    calibration_axis_std_z      DOUBLE PRECISION,
    calibration_sample_count    INT,
    -- TRUE when the rider started moving before the full target window
    -- elapsed and the capture was truncated to whatever was banked.
    calibration_truncated       BOOLEAN,
    -- 'good' / 'poor' tag from `classifyCalibrationQuality` in
    -- @tarmoto/shared (gates on per-axis std, sample-count floor,
    -- finite-value check, and ‖mean‖ ≈ gravity plausibility).
    calibration_quality         VARCHAR(8),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE surface_readings
    ADD CONSTRAINT fk_surface_readings_ride
    FOREIGN KEY (ride_id) REFERENCES rides(id);

CREATE INDEX idx_rides_user ON rides(user_id);
CREATE INDEX idx_rides_geom ON rides USING GIST(route_geom);
CREATE INDEX idx_rides_started ON rides(started_at DESC);

CREATE TABLE ride_segments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id         UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    road_segment_id UUID REFERENCES road_segments(id),
    sequence        INT NOT NULL,
    speed_avg       FLOAT,
    speed_max       FLOAT,
    lean_angle_max  FLOAT,
    quality_reading FLOAT,
    entered_at      TIMESTAMPTZ,
    exited_at       TIMESTAMPTZ
);

CREATE INDEX idx_ride_segments_ride ON ride_segments(ride_id);

CREATE TABLE ride_stats (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id                 UUID NOT NULL UNIQUE REFERENCES rides(id) ON DELETE CASCADE,
    elevation_gain          FLOAT,
    elevation_loss          FLOAT,
    curve_count             INT,
    fuel_estimate_l         FLOAT,
    duration                INTERVAL,
    avg_lean_angle          FLOAT,
    max_lean_angle          FLOAT,
    calories_est            INT
);

-- ============================================================
-- HAZARD REPORTS
-- ============================================================

CREATE TABLE hazard_reports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    road_segment_id UUID REFERENCES road_segments(id),
    location        GEOMETRY(Point, 4326) NOT NULL,
    hazard_type     VARCHAR(30) NOT NULL,    -- pothole, gravel, oil_spill, roadworks, animals, police, flooding, ice, other
    severity        VARCHAR(10) DEFAULT 'medium', -- low, medium, high
    note            TEXT,
    photo_url       TEXT,                    -- optional single photo (US-4); managed-origin URL returned by POST /hazards/photos
    photo_filename  TEXT,                    -- resolved managed filename of photo_url (NULL for third-party); indexed identity for the cap-orphan cleanup
    confirmations   INT DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,    -- auto-expiry: 24-72h based on type
    confirmed_at    TIMESTAMPTZ,             -- last confirmation timestamp
    -- Admin moderation (Phase 4): 'visible' | 'hidden'. Hidden rows are
    -- excluded from every public read path; the row is retained for audit.
    moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
    moderation_reason VARCHAR(500),
    moderated_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    moderated_at    TIMESTAMPTZ
);

CREATE INDEX idx_hazard_reports_location ON hazard_reports USING GIST(location);
CREATE INDEX idx_hazard_reports_active ON hazard_reports(is_active, expires_at);
CREATE INDEX idx_hazard_reports_segment ON hazard_reports(road_segment_id);
CREATE INDEX idx_hazard_reports_moderation ON hazard_reports(moderation_status, created_at);
-- Backs the per-user rolling-24h count for the hazard_reports_per_day cap.
CREATE INDEX idx_hazard_reports_user_created ON hazard_reports(user_id, created_at);
-- Indexed managed-file identity for the cap-orphan cleanup existence check.
CREATE INDEX idx_hazard_reports_photo_filename ON hazard_reports(photo_filename) WHERE photo_filename IS NOT NULL;

-- ============================================================
-- ROAD REVIEWS
-- ============================================================

CREATE TABLE road_reviews (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    road_segment_id UUID NOT NULL REFERENCES road_segments(id),
    rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    bike_model      VARCHAR(100),
    photos          TEXT[],                  -- S3 URLs
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Admin moderation (Phase 4): 'visible' | 'hidden'. Hidden reviews are
    -- excluded from public lists + rating aggregates (the author still sees
    -- their own); the row is retained for audit.
    moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
    moderation_reason VARCHAR(500),
    moderated_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    moderated_at    TIMESTAMPTZ
);

CREATE INDEX idx_road_reviews_segment ON road_reviews(road_segment_id);
CREATE UNIQUE INDEX idx_road_reviews_unique ON road_reviews(user_id, road_segment_id);
CREATE INDEX idx_road_reviews_moderation ON road_reviews(moderation_status, created_at);

-- ============================================================
-- TRIPS & COLLABORATIVE PLANNING
-- ============================================================

CREATE TABLE trips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(200) NOT NULL,
    region          VARCHAR(200),
    num_days        INT NOT NULL DEFAULT 1,
    daily_km_min    FLOAT DEFAULT 150,
    daily_km_max    FLOAT DEFAULT 350,
    min_quality     FLOAT DEFAULT 3.0,
    road_preference VARCHAR(30) DEFAULT 'curvy', -- curvy, scenic, fast, mixed
    status          VARCHAR(20) DEFAULT 'draft', -- draft, planned, active, completed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trips_owner ON trips(owner_id);

CREATE TABLE trip_members (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) DEFAULT 'viewer', -- owner, editor, viewer (1793)
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(trip_id, user_id)
);

-- Pending email invites (the `invited` collaborator state; `joined` lives in
-- trip_members). One row per (trip, email) carrying the role granted on
-- acceptance and a PERSONAL invite code used by the emailed join link, so a
-- single invite can be revoked in isolation. Personal codes are the ONLY
-- join codes — the static trip-wide code was dropped in migration 1794.
-- The row is deleted when the invitee joins. (Migrations 1793/1794)
CREATE TABLE trip_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(20) NOT NULL DEFAULT 'viewer', -- editor, viewer
    invite_code     VARCHAR(20) NOT NULL UNIQUE,
    invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(trip_id, email)
);
CREATE INDEX idx_trip_invites_email ON trip_invites(email);

CREATE TABLE trip_days (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_number      INT NOT NULL,
    title           VARCHAR(200),
    distance_km     FLOAT,
    route_geom      GEOMETRY(LineString, 4326),
    avg_quality     FLOAT,
    elevation_gain  FLOAT,
    estimated_time  INTERVAL,
    -- Multi-day planner: true when this day's start mirrors the previous
    -- day's end (the overnight link). Day 1 is always false.
    start_linked    BOOLEAN NOT NULL DEFAULT FALSE,
    -- Per-leg road-character overrides (planner revision 3 §C): a JSON
    -- array with one routing preference per consecutive routing-waypoint
    -- pair, in travel order. NULL = every leg inherits the trip-wide
    -- preference.
    leg_preferences JSONB,
    UNIQUE(trip_id, day_number)
);

CREATE TABLE trip_waypoints (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_day_id     UUID NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
    sequence        INT NOT NULL,
    location        GEOMETRY(Point, 4326) NOT NULL,
    name            VARCHAR(200),
    waypoint_type   VARCHAR(30) DEFAULT 'via', -- start, via, fuel, food, coffee, hotel, photo, end
    poi_category    VARCHAR(30),                -- semantic planner POI category; translated by clients
    road_segment_id UUID REFERENCES road_segments(id),
    notes           TEXT,
    duration_min    INT                        -- planned stop duration
);

CREATE INDEX idx_trip_waypoints_day ON trip_waypoints(trip_day_id, sequence);

-- Per-trip chat. The keyset pagination index lives in the
-- AddTripCollaboration migration; the moderation columns were added in
-- Phase 4 (AddContentModeration).
CREATE TABLE trip_messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Admin moderation (Phase 4): 'visible' | 'hidden'. Hidden messages are
    -- excluded from the trip chat fetch; the row is retained for audit.
    moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
    moderation_reason VARCHAR(500),
    moderated_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    moderated_at    TIMESTAMPTZ
);

CREATE INDEX idx_trip_messages_moderation ON trip_messages(moderation_status, created_at);

-- ============================================================
-- FUN ZONES (auto-discovered clusters of great roads)
-- ============================================================

CREATE TABLE fun_zones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    boundary        GEOMETRY(Polygon, 4326) NOT NULL,
    name            VARCHAR(200),
    composite_score FLOAT NOT NULL,
    road_count      INT NOT NULL,
    total_curve_km  FLOAT,
    avg_quality     FLOAT,
    best_season     VARCHAR(20),             -- spring, summer, autumn, year_round
    last_calculated TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fun_zones_boundary ON fun_zones USING GIST(boundary);
CREATE INDEX idx_fun_zones_score ON fun_zones(composite_score DESC);

CREATE TABLE fun_zone_roads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fun_zone_id     UUID NOT NULL REFERENCES fun_zones(id) ON DELETE CASCADE,
    road_segment_id UUID NOT NULL REFERENCES road_segments(id),
    contribution_score FLOAT,
    UNIQUE(fun_zone_id, road_segment_id)
);

-- ============================================================
-- COMMUTE ROUTES
-- ============================================================

CREATE TABLE commute_routes (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                    VARCHAR(100) DEFAULT 'Default',
    origin                  GEOMETRY(Point, 4326) NOT NULL,
    destination             GEOMETRY(Point, 4326) NOT NULL,
    route_geom              GEOMETRY(LineString, 4326),
    distance_km             FLOAT,
    avg_duration            INTERVAL,
    avg_quality             FLOAT,
    routing_engine_version  VARCHAR(64),
    routing_cache_updated_at TIMESTAMPTZ,
    is_primary              BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commute_routes_user ON commute_routes(user_id);

-- ============================================================
-- USEFUL VIEWS
-- ============================================================

-- Road segments with quality summary
CREATE VIEW v_road_quality AS
SELECT
    rs.id,
    rs.road_name,
    rs.road_number,
    rs.length_m,
    rs.curviness_score,
    rs.quality_score,
    rs.surface_type,
    rs.reading_count,
    rs.confidence,
    rs.geom,
    COUNT(hr.id) FILTER (WHERE hr.is_active) AS active_hazards,
    AVG(rr.rating) AS avg_review_rating,
    COUNT(rr.id) AS review_count
FROM road_segments rs
LEFT JOIN hazard_reports hr ON hr.road_segment_id = rs.id AND hr.is_active = TRUE
LEFT JOIN road_reviews rr ON rr.road_segment_id = rs.id
GROUP BY rs.id;

-- Active hazards with user info
CREATE VIEW v_active_hazards AS
SELECT
    hr.*,
    u.display_name AS reporter_name,
    rs.road_name,
    rs.road_number
FROM hazard_reports hr
JOIN users u ON u.id = hr.user_id
LEFT JOIN road_segments rs ON rs.id = hr.road_segment_id
WHERE hr.is_active = TRUE AND hr.expires_at > NOW();

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- #495: re-aggregate a single segment, dropping readings whose
-- quality_score deviates >2σ from the segment mean before applying
-- recency weighting and confidence scoring (ML_MODEL_SPEC §8.3 step 1).
-- Filtering is skipped when fewer than 3 valid readings exist
-- (stddev_samp is undefined / trivial) or when all readings produced
-- the same quality score (no spread).
-- Returns the count of readings dropped on this run.
CREATE OR REPLACE FUNCTION update_road_quality_for_segment(p_segment_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_filtered_count INT := 0;
BEGIN
    WITH scored AS (
        SELECT
            sr.id,
            sr.user_id,
            sr.recorded_at,
            CASE sr.classification
                WHEN 'excellent' THEN 5.0
                WHEN 'good'      THEN 4.0
                WHEN 'fair'      THEN 3.0
                WHEN 'poor'      THEN 2.0
                WHEN 'very_poor' THEN 1.0
            END AS quality_score
        FROM surface_readings sr
        WHERE sr.road_segment_id = p_segment_id
    ),
    valid AS (
        SELECT * FROM scored WHERE quality_score IS NOT NULL
    ),
    stats AS (
        SELECT
            COUNT(*)::int        AS total_count,
            AVG(quality_score)   AS mean_q,
            stddev_samp(quality_score) AS std_q
        FROM valid
    ),
    flagged AS (
        SELECT
            v.id,
            v.user_id,
            v.recorded_at,
            v.quality_score,
            CASE
                WHEN s.total_count < 3 THEN false
                WHEN s.std_q IS NULL OR s.std_q = 0 THEN false
                WHEN ABS(v.quality_score - s.mean_q) > 2 * s.std_q THEN true
                ELSE false
            END AS is_outlier
        FROM valid v
        CROSS JOIN stats s
    ),
    kept AS (
        SELECT
            quality_score,
            user_id,
            CASE
                WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
                WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
                WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
                ELSE 0.2
            END AS recency_weight
        FROM flagged
        WHERE NOT is_outlier
    ),
    agg AS (
        SELECT
            SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
            COUNT(*)::int                AS reading_count,
            COUNT(DISTINCT user_id)::int AS unique_rider_count
        FROM kept
    ),
    fc AS (
        SELECT COUNT(*)::int AS filtered_count FROM flagged WHERE is_outlier
    ),
    surface_mode AS (
        SELECT surface_type
        FROM surface_readings
        WHERE road_segment_id = p_segment_id
          AND surface_type IS NOT NULL
        GROUP BY surface_type
        ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
        LIMIT 1
    )
    UPDATE road_segments rs
    SET
        -- Blend the rider mean with the OSM seed by rider count (k = 4).
        -- No valid readings → pure seed; no seed → pure rider mean.
        quality_score = CASE
            WHEN agg.reading_count = 0 OR agg.quality_score IS NULL
                THEN rs.osm_quality_seed
            WHEN rs.osm_quality_seed IS NULL
                THEN agg.quality_score
            ELSE (agg.quality_score * agg.reading_count + rs.osm_quality_seed * 4)
                 / (agg.reading_count + 4)
        END,
        reading_count = agg.reading_count,
        confidence = CASE
            WHEN agg.reading_count >= 20 AND agg.unique_rider_count >= 5 THEN 100
            WHEN agg.reading_count >= 10 THEN 90
            WHEN agg.reading_count >= 5  THEN 70
            WHEN agg.reading_count >= 3  THEN 50
            WHEN agg.reading_count >= 1  THEN 20
            ELSE 0
        END,
        surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
        -- #796: sticky true once a rider classifies the surface, so it outlives
        -- the location_retention sweep like the aggregate surface_type it guards.
        surface_from_reading = rs.surface_from_reading
            OR (SELECT surface_type FROM surface_mode) IS NOT NULL,
        last_filtered_count = fc.filtered_count,
        last_updated = NOW()
    FROM agg, fc
    WHERE rs.id = p_segment_id
    RETURNING rs.last_filtered_count INTO v_filtered_count;

    RETURN COALESCE(v_filtered_count, 0);
END;
$$;

-- Auto-update quality_score when new readings arrive. The actual
-- aggregation rule lives in update_road_quality_for_segment(uuid)
-- so the trigger and the migration backfill share one definition.
CREATE OR REPLACE FUNCTION update_road_quality()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_filtered INT;
BEGIN
    v_filtered := update_road_quality_for_segment(NEW.road_segment_id);
    IF v_filtered > 0 THEN
        RAISE LOG 'road_quality_aggregation_filtered segment=% filtered_count=%',
            NEW.road_segment_id, v_filtered;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_road_quality
AFTER INSERT ON surface_readings
FOR EACH ROW EXECUTE FUNCTION update_road_quality();

-- Auto-expire hazard reports
CREATE OR REPLACE FUNCTION expire_hazards()
RETURNS void AS $$
BEGIN
    UPDATE hazard_reports
    SET is_active = FALSE
    WHERE expires_at < NOW() AND is_active = TRUE;
END;
$$ LANGUAGE plpgsql;

-- Find nearby road segments (for routing queries)
CREATE OR REPLACE FUNCTION find_nearby_segments(
    lat FLOAT, lng FLOAT, radius_m INT DEFAULT 5000
)
RETURNS TABLE(
    segment_id UUID,
    road_name VARCHAR,
    quality_score FLOAT,
    curviness_score FLOAT,
    surface_type VARCHAR,
    distance_m FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        rs.id,
        rs.road_name,
        rs.quality_score,
        rs.curviness_score,
        rs.surface_type,
        ST_Distance(rs.geom::geography, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) AS distance_m
    FROM road_segments rs
    WHERE ST_DWithin(
        rs.geom::geography,
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
        radius_m
    )
    ORDER BY distance_m;
END;
$$ LANGUAGE plpgsql;
