import { describe, expect, it } from "vitest";
import {
  findOwnerId,
  tripFromDetail,
  tripSummaryFromWire,
  type TripDetailDay,
  type TripDetailMember,
  type TripDetailResponse,
  type TripSummaryWire,
} from "./trip-from-detail";

// The backend can serve roles outside the current `TripMemberDto` union
// (forward-compat); the adapter defends against them. Build such fixtures via
// a cast since the generated type only lists the known roles.
const asMembers = (members: unknown[]): TripDetailMember[] =>
  members as TripDetailMember[];

function makeDetail(
  overrides: Partial<TripDetailResponse> = {},
): TripDetailResponse {
  return {
    id: "trip-1",
    title: "Italian Loop",
    region: "Dolomites",
    num_days: 3,
    status: "planned",
    member_count: 2,
    owner_id: "owner-1",
    folder_id: null,
    distance_km: null,
    quality_avg: null,
    passes_count: null,
    overview_geometry: null,
    created_at: "2026-04-24T10:00:00.000Z",
    daily_km_min: 200,
    daily_km_max: 300,
    min_quality: 4,
    road_preference: "scenic",
    members: asMembers([
      {
        user_id: "owner-1",
        display_name: "Adam",
        role: "owner",
        joined_at: "2026-04-24T10:00:00.000Z",
      },
      {
        user_id: "member-1",
        display_name: "Eve",
        role: "member",
        joined_at: "2026-04-24T11:00:00.000Z",
      },
    ]),
    days: [
      {
        id: "d-1",
        day_number: 1,
        title: "Climb to Sella",
        distance_km: 220.5,
        avg_quality: 4.2,
        elevation_gain: 1500,
        elevation_loss: 1500,
        curviness_score: 75,
        scenic_score: 80,
        estimated_time_min: 270,
        start_linked: false,
        route_geometry: [
          { lat: 46.5, lng: 11.2 },
          { lat: 46.6, lng: 11.3 },
        ],
        waypoints: [
          {
            id: "w-1",
            sequence: 0,
            lat: 46.5,
            lng: 11.2,
            name: "Bolzano",
            waypoint_type: "start",
            road_segment_id: null,
            notes: null,
            duration_min: null,
          },
          {
            id: "w-2",
            sequence: 2,
            lat: 46.6,
            lng: 11.3,
            name: "Hotel Sella",
            waypoint_type: "hotel",
            road_segment_id: null,
            notes: null,
            duration_min: null,
          },
          {
            id: "w-3",
            sequence: 1,
            lat: 46.55,
            lng: 11.25,
            name: "Coffee stop",
            waypoint_type: "coffee",
            road_segment_id: null,
            notes: null,
            duration_min: 30,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("tripFromDetail", () => {
  it("maps top-level fields including renamed title → name", () => {
    const trip = tripFromDetail(makeDetail());
    expect(trip.id).toBe("trip-1");
    expect(trip.name).toBe("Italian Loop");
    expect(trip.status).toBe("planned");
    expect(trip.createdAt).toBe("2026-04-24T10:00:00.000Z");
  });

  it("falls back to a safe status when the backend returns an unknown value", () => {
    // `"archived"` is outside the `TripDetailDto.status` union; the adapter
    // defends against a future/legacy status the client doesn't model.
    const trip = tripFromDetail(
      makeDetail({
        status: "archived" as unknown as TripDetailResponse["status"],
      }),
    );
    expect(trip.status).toBe("draft");
  });

  it("carries the #647 rollups so a detail-derived list row isn't blank", () => {
    const trip = tripFromDetail(
      makeDetail({ distance_km: 610, quality_avg: 4.4, passes_count: 6 }),
    );
    expect(trip.distance_km).toBe(610);
    expect(trip.quality_avg).toBeCloseTo(4.4);
    expect(trip.passes_count).toBe(6);
  });

  it("defaults the rollups to null when the detail omits them", () => {
    const trip = tripFromDetail(makeDetail());
    expect(trip.distance_km).toBeNull();
    expect(trip.quality_avg).toBeNull();
    expect(trip.passes_count).toBeNull();
  });

  it("derives planner parameters from the persisted daily_km band and num_days", () => {
    const trip = tripFromDetail(makeDetail());
    expect(trip.parameters.days).toBe(3);
    // Midpoint of [200, 300]; chosen so the planner's slider lands in
    // the middle of the persisted band rather than at an endpoint.
    expect(trip.parameters.dailyKmTarget).toBe(250);
    expect(trip.parameters.roadPreference).toBe("scenic");
    expect(trip.parameters.minQuality).toBe(4);
  });

  it("falls back to the 'mixed' road preference when the value is unknown", () => {
    const trip = tripFromDetail(
      makeDetail({
        road_preference:
          "speed" as unknown as TripDetailResponse["road_preference"],
      }),
    );
    expect(trip.parameters.roadPreference).toBe("mixed");
  });

  it("maps the backend fast road preference to the planner direct option", () => {
    const trip = tripFromDetail(makeDetail({ road_preference: "fast" }));
    expect(trip.parameters.roadPreference).toBe("direct");
  });

  it("carries persisted per-leg preferences onto the day (null when absent)", () => {
    const detail = makeDetail();
    detail.days[0]!.leg_preferences = ["scenic_balance", "maximum_twisty"];
    const trip = tripFromDetail(detail);
    expect(trip.days[0]!.legPreferences).toEqual([
      "scenic_balance",
      "maximum_twisty",
    ]);

    const bare = tripFromDetail(makeDetail());
    expect(bare.days[0]!.legPreferences).toBeNull();
  });

  it("sorts waypoints by sequence and translates the backend type vocabulary", () => {
    const trip = tripFromDetail(makeDetail());
    const wps = trip.days[0]!.waypoints;
    expect(wps.map((w) => w.id)).toEqual(["w-1", "w-3", "w-2"]);
    expect(wps[0]!.type).toBe("start");
    // 'coffee' has no direct local equivalent; the planner renders it as
    // a generic rest stop so the type collapses to 'rest'.
    expect(wps[1]!.type).toBe("rest");
    // Likewise 'hotel' folds into 'accommodation' to match the planner UI.
    expect(wps[2]!.type).toBe("accommodation");
  });

  it("surfaces the day's hotel waypoint as overnightStop so DaysList can render it", () => {
    const trip = tripFromDetail(makeDetail());
    expect(trip.days[0]!.overnightStop).toEqual({
      id: "w-2",
      name: "Hotel Sella",
      type: "accommodation",
      location: { lat: 46.6, lng: 11.3 },
    });
  });

  it("falls back to a 'Day N overnight' label when the hotel waypoint has no name", () => {
    const detail = makeDetail();
    const day = detail.days[0]!;
    const trip = tripFromDetail({
      ...detail,
      days: [
        {
          ...day,
          waypoints: day.waypoints.map((w) =>
            w.waypoint_type === "hotel" ? { ...w, name: null } : w,
          ),
        },
      ],
    });
    expect(trip.days[0]!.overnightStop?.name).toBe("Day 1 overnight");
  });

  it("leaves overnightStop undefined when the day has no hotel waypoint", () => {
    const detail = makeDetail();
    const day = detail.days[0]!;
    const trip = tripFromDetail({
      ...detail,
      days: [
        {
          ...day,
          waypoints: day.waypoints.filter((w) => w.waypoint_type !== "hotel"),
        },
      ],
    });
    expect(trip.days[0]!.overnightStop).toBeUndefined();
  });

  it("infers a non-final day's overnight from its end when the stay was normalized to an end", () => {
    const detail = makeDetail();
    const base = detail.days[0]!;
    const mkDay = (
      n: number,
      start: { lat: number; lng: number },
      end: { lat: number; lng: number },
    ): TripDetailDay => ({
      ...base,
      id: `d-${n}`,
      day_number: n,
      // No `hotel` — a manual save normalized the stay to a routed `end`.
      waypoints: [
        {
          ...base.waypoints[0]!,
          id: `s-${n}`,
          sequence: 0,
          lat: start.lat,
          lng: start.lng,
          waypoint_type: "start",
          name: "Start",
        },
        {
          ...base.waypoints[0]!,
          id: `e-${n}`,
          sequence: 1,
          lat: end.lat,
          lng: end.lng,
          waypoint_type: "end",
          name: `Day ${n} finish`,
        },
      ],
    });
    const trip = tripFromDetail({
      ...detail,
      num_days: 2,
      days: [
        mkDay(1, { lat: 46, lng: 10 }, { lat: 46.5, lng: 10.5 }),
        mkDay(2, { lat: 46.5, lng: 10.5 }, { lat: 47, lng: 11 }),
      ],
    });

    // Day 1 (non-final): its end IS the overnight boundary.
    expect(trip.days[0]!.overnightStop).toMatchObject({
      type: "accommodation",
      location: { lat: 46.5, lng: 10.5 },
    });
    // Day 2 (final): its end is the trip finish, not an overnight.
    expect(trip.days[1]!.overnightStop).toBeUndefined();
  });

  it("converts route_geometry {lat,lng}[] into GeoJSON [lng,lat][] tuples", () => {
    const trip = tripFromDetail(makeDetail());
    const geom = trip.days[0]!.routeGeometry!;
    expect(geom.type).toBe("LineString");
    expect(geom.coordinates).toEqual([
      [11.2, 46.5],
      [11.3, 46.6],
    ]);
  });

  it("omits routeGeometry on days the backend returns with no points", () => {
    const trip = tripFromDetail(
      makeDetail({
        days: [
          {
            ...makeDetail().days[0]!,
            route_geometry: [],
          },
        ],
      }),
    );
    expect(trip.days[0]!.routeGeometry).toBeUndefined();
  });

  it("maps backend roles into the local collaborator vocabulary", () => {
    const trip = tripFromDetail(makeDetail());
    expect(trip.collaborators).toEqual([
      { userId: "owner-1", displayName: "Adam", role: "owner" },
      // Backend `member` role is read-only on the trip detail page,
      // hence it maps to the local `viewer` role rather than `editor`.
      { userId: "member-1", displayName: "Eve", role: "viewer" },
    ]);
  });

  it("forwards owner_id and folder_id when the detail response carries them", () => {
    const trip = tripFromDetail(
      makeDetail({ owner_id: "owner-1", folder_id: "folder-abc" }),
    );
    // List-side consumers (e.g. the duplicate flow) rely on these
    // summary-flavoured fields to keep the resulting card in the
    // right folder and to render owner-aware affordances.
    expect(trip.owner_id).toBe("owner-1");
    expect(trip.folder_id).toBe("folder-abc");
  });

  it("normalises a null folder_id from the wire to null", () => {
    const trip = tripFromDetail(makeDetail({ folder_id: null }));
    // `null` matches the wire convention for "unfiled"; consumers
    // can distinguish that from an absent field with `folder_id ?? null`.
    expect(trip.folder_id).toBeNull();
  });
});

describe("findOwnerId", () => {
  it("returns the user_id of the member tagged 'owner'", () => {
    expect(findOwnerId(makeDetail())).toBe("owner-1");
  });

  it("returns null when no member has the owner role", () => {
    expect(
      findOwnerId(
        makeDetail({
          members: asMembers([
            {
              user_id: "member-1",
              display_name: "Eve",
              role: "member",
              joined_at: "",
            },
          ]),
        }),
      ),
    ).toBeNull();
  });
});

function makeWire(overrides: Partial<TripSummaryWire> = {}): TripSummaryWire {
  return {
    id: "trip-1",
    owner_id: "owner-1",
    title: "Italian Loop",
    region: "Dolomites",
    num_days: 3,
    status: "planned",
    member_count: 2,
    folder_id: null,
    created_at: "2026-04-24T10:00:00.000Z",
    distance_km: null,
    quality_avg: null,
    passes_count: null,
    overview_geometry: null,
    ...overrides,
  };
}

describe("tripSummaryFromWire", () => {
  it("translates snake_case name/createdAt into the local shape", () => {
    const summary = tripSummaryFromWire(makeWire());
    expect(summary.name).toBe("Italian Loop");
    expect(summary.createdAt).toBe("2026-04-24T10:00:00.000Z");
    expect(summary.status).toBe("planned");
    expect(summary.num_days).toBe(3);
  });

  it("passes the #647 summary-meta fields through when present", () => {
    const summary = tripSummaryFromWire(
      makeWire({ distance_km: 480, quality_avg: 4.2, passes_count: 6 }),
    );
    expect(summary.distance_km).toBe(480);
    expect(summary.quality_avg).toBe(4.2);
    expect(summary.passes_count).toBe(6);
  });

  it("maps missing summary-meta fields to null so cards can null-guard", () => {
    const summary = tripSummaryFromWire(makeWire());
    expect(summary.distance_km).toBeNull();
    expect(summary.quality_avg).toBeNull();
    expect(summary.passes_count).toBeNull();
  });
});
