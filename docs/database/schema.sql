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
    surface_type    VARCHAR(30) DEFAULT 'unknown',  -- asphalt, concrete, cobblestone, gravel, dirt
    reading_count   INT DEFAULT 0,           -- number of rider passes
    confidence      INT DEFAULT 0,           -- 0-100, increases with more readings
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
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    road_segment_id UUID NOT NULL REFERENCES road_segments(id),
    ride_id         UUID,  -- FK added after rides table
    user_id         UUID REFERENCES users(id),
    iri_value       FLOAT NOT NULL,          -- International Roughness Index
    classification  VARCHAR(20) NOT NULL,    -- excellent, good, fair, poor, very_poor
    surface_type    VARCHAR(30),
    vibration_rms   FLOAT,                   -- root mean square of accelerometer
    speed_at_reading FLOAT,                  -- km/h, for calibration
    device_model    VARCHAR(100),            -- phone model for ML calibration
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_surface_readings_segment ON surface_readings(road_segment_id);
CREATE INDEX idx_surface_readings_time ON surface_readings(recorded_at DESC);

-- ============================================================
-- RIDES & TRACKING
-- ============================================================

CREATE TABLE rides (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    distance_km     FLOAT,
    avg_speed       FLOAT,
    max_speed       FLOAT,
    route_geom      GEOMETRY(LineString, 4326),
    avg_road_quality FLOAT,
    ride_type       VARCHAR(20) DEFAULT 'free', -- free, commute, trip, tracked
    status          VARCHAR(20) DEFAULT 'active', -- active, completed, cancelled
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    -- US-19: per-ride lean histogram. Bucket boundaries owned by
    -- `@tarmoto/shared` (`LEAN_BUCKETS`).
    lean_distribution_json  JSONB,
    calories_est            INT
);

-- ============================================================
-- HAZARD REPORTS
-- ============================================================

CREATE TABLE hazard_reports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    road_segment_id UUID REFERENCES road_segments(id),
    location        GEOMETRY(Point, 4326) NOT NULL,
    hazard_type     VARCHAR(30) NOT NULL,    -- pothole, gravel, oil_spill, roadworks, animals, police, flooding, ice, other
    severity        VARCHAR(10) DEFAULT 'medium', -- low, medium, high
    note            TEXT,
    confirmations   INT DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,    -- auto-expiry: 24-72h based on type
    confirmed_at    TIMESTAMPTZ              -- last confirmation timestamp
);

CREATE INDEX idx_hazard_reports_location ON hazard_reports USING GIST(location);
CREATE INDEX idx_hazard_reports_active ON hazard_reports(is_active, expires_at);
CREATE INDEX idx_hazard_reports_segment ON hazard_reports(road_segment_id);

-- ============================================================
-- ROAD REVIEWS
-- ============================================================

CREATE TABLE road_reviews (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    road_segment_id UUID NOT NULL REFERENCES road_segments(id),
    rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    bike_model      VARCHAR(100),
    photos          TEXT[],                  -- S3 URLs
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_road_reviews_segment ON road_reviews(road_segment_id);
CREATE UNIQUE INDEX idx_road_reviews_unique ON road_reviews(user_id, road_segment_id);

-- ============================================================
-- TRIPS & COLLABORATIVE PLANNING
-- ============================================================

CREATE TABLE trips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL REFERENCES users(id),
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
    user_id         UUID NOT NULL REFERENCES users(id),
    role            VARCHAR(20) DEFAULT 'member', -- owner, admin, member
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(trip_id, user_id)
);

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
    UNIQUE(trip_id, day_number)
);

CREATE TABLE trip_waypoints (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_day_id     UUID NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
    sequence        INT NOT NULL,
    location        GEOMETRY(Point, 4326) NOT NULL,
    name            VARCHAR(200),
    waypoint_type   VARCHAR(30) DEFAULT 'via', -- start, via, fuel, food, coffee, hotel, photo, end
    road_segment_id UUID REFERENCES road_segments(id),
    notes           TEXT,
    duration_min    INT                        -- planned stop duration
);

CREATE INDEX idx_trip_waypoints_day ON trip_waypoints(trip_day_id, sequence);

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
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    name            VARCHAR(100) DEFAULT 'Default',
    origin          GEOMETRY(Point, 4326) NOT NULL,
    destination     GEOMETRY(Point, 4326) NOT NULL,
    route_geom      GEOMETRY(LineString, 4326),
    distance_km     FLOAT,
    avg_duration    INTERVAL,
    avg_quality     FLOAT,
    is_primary      BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- Auto-update quality_score when new readings arrive
CREATE OR REPLACE FUNCTION update_road_quality()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE road_segments rs
    SET
        quality_score = stats.quality_score,
        reading_count = stats.reading_count,
        confidence = CASE
            WHEN stats.reading_count >= 20 AND stats.unique_rider_count >= 5 THEN 100
            WHEN stats.reading_count >= 10 THEN 90
            WHEN stats.reading_count >= 5 THEN 70
            WHEN stats.reading_count >= 3 THEN 50
            WHEN stats.reading_count >= 1 THEN 20
            ELSE 0
        END,
        surface_type = COALESCE(surface_mode.surface_type, rs.surface_type),
        last_updated = NOW()
    FROM (
        SELECT
            SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
            COUNT(*)::int AS reading_count,
            COUNT(DISTINCT user_id)::int AS unique_rider_count
        FROM (
            SELECT
                CASE classification
                    WHEN 'excellent' THEN 5.0
                    WHEN 'good' THEN 4.0
                    WHEN 'fair' THEN 3.0
                    WHEN 'poor' THEN 2.0
                    WHEN 'very_poor' THEN 1.0
                END AS quality_score,
                CASE
                    WHEN recorded_at >= NOW() - INTERVAL '30 days' THEN 1.0
                    WHEN recorded_at >= NOW() - INTERVAL '90 days' THEN 0.7
                    WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
                    ELSE 0.2
                END AS recency_weight,
                user_id
            FROM surface_readings
            WHERE road_segment_id = NEW.road_segment_id
        ) weighted_readings
        WHERE quality_score IS NOT NULL
    ) stats
    LEFT JOIN LATERAL (
        SELECT surface_type
        FROM surface_readings
        WHERE road_segment_id = NEW.road_segment_id
        AND surface_type IS NOT NULL
        GROUP BY surface_type
        ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
        LIMIT 1
    ) surface_mode ON TRUE
    WHERE rs.id = NEW.road_segment_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
