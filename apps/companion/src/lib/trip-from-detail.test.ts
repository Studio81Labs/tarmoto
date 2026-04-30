import { describe, expect, it } from "vitest";
import {
  findOwnerId,
  tripFromDetail,
  type TripDetailResponse,
} from "./trip-from-detail";

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
    created_at: "2026-04-24T10:00:00.000Z",
    daily_km_min: 200,
    daily_km_max: 300,
    min_quality: 4,
    road_preference: "scenic",
    invite_code: "ABCDEFGH",
    members: [
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
    ],
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
    const trip = tripFromDetail(makeDetail({ status: "archived" }));
    expect(trip.status).toBe("draft");
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
    const trip = tripFromDetail(makeDetail({ road_preference: "speed" }));
    expect(trip.parameters.roadPreference).toBe("mixed");
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
});

describe("findOwnerId", () => {
  it("returns the user_id of the member tagged 'owner'", () => {
    expect(findOwnerId(makeDetail())).toBe("owner-1");
  });

  it("returns null when no member has the owner role", () => {
    expect(
      findOwnerId(
        makeDetail({
          members: [
            {
              user_id: "member-1",
              display_name: "Eve",
              role: "member",
              joined_at: "",
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
