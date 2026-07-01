/**
 * Navigation helpers — US-16.
 *
 * Covers maneuver extraction, polyline projection, the per-tick session
 * state machine, and the phrase generator. All pure — no React/native
 * bindings required.
 */
import {
  NavSession,
  announcementKey,
  bearingDeg,
  extractManeuvers,
  haversineM,
  headingDelta,
  phraseForAnnouncement,
  projectOnPolyline,
  resolveVoiceLocale,
  WARNING_FAR_M,
  WARNING_NEAR_M,
} from "../navigation";
import type { LatLng } from "@/types";

describe("bearingDeg + headingDelta", () => {
  it("bearings match cardinal directions", () => {
    const origin: LatLng = { lat: 49.5, lng: 18.5 };
    const north: LatLng = { lat: 49.6, lng: 18.5 };
    const east: LatLng = { lat: 49.5, lng: 18.6 };
    expect(Math.round(bearingDeg(origin, north))).toBe(0);
    expect(Math.round(bearingDeg(origin, east))).toBe(90);
  });

  it("headingDelta wraps to (-180, 180] with a rightward 180 bias", () => {
    expect(headingDelta(350, 10)).toBeCloseTo(20, 5);
    expect(headingDelta(10, 350)).toBeCloseTo(-20, 5);
    expect(headingDelta(0, 180)).toBe(180);
    // Exact anti-parallel is treated as right (positive) so U-turns
    // classify consistently instead of flipping on floating-point noise.
    expect(headingDelta(180, 0)).toBe(180);
  });
});

describe("haversineM", () => {
  it("gives ~111 km per 1° of latitude", () => {
    const m = haversineM(49.0, 18.0, 50.0, 18.0);
    expect(m / 1000).toBeGreaterThan(110);
    expect(m / 1000).toBeLessThan(112);
  });
});

// Helper: walk a polyline straight east from origin with 1° headings,
// then turn by a given delta and continue. Returns the polyline.
function buildCornerPolyline(
  origin: LatLng,
  leg1Steps: number,
  turnDeltaDeg: number,
  leg2Steps: number,
  stepMeters = 50,
): LatLng[] {
  // Tiny step in degrees at mid-latitudes for ~50 m of easting. We don't
  // need precision here — the maneuvers tests just care about signed
  // heading change and roughly comparable segment lengths.
  const degPerMeter = 1 / 111000;
  const scale = stepMeters * degPerMeter;
  const points: LatLng[] = [origin];

  let bearingRad = 0; // north
  const turnRight = (deg: number) => {
    bearingRad += (deg * Math.PI) / 180;
  };

  const step = () => {
    const last = points[points.length - 1];
    if (!last) throw new Error("polyline has no points to step from");
    // In our tiny flat-earth model, bearing 0 = +lat, bearing 90 = +lng.
    // cos/sin drive lat/lng respectively.
    const next = {
      lat: last.lat + Math.cos(bearingRad) * scale,
      lng:
        last.lng +
        (Math.sin(bearingRad) * scale) / Math.cos((last.lat * Math.PI) / 180),
    };
    points.push(next);
  };

  // Point initial bearing east so turns are visible as left/right.
  turnRight(90);
  for (let i = 0; i < leg1Steps; i++) step();
  turnRight(turnDeltaDeg);
  for (let i = 0; i < leg2Steps; i++) step();
  return points;
}

describe("extractManeuvers", () => {
  it("empty polyline → no maneuvers", () => {
    expect(extractManeuvers([])).toEqual([]);
  });

  it("single point → depart + arrive at the same vertex", () => {
    const m = extractManeuvers([{ lat: 49, lng: 18 }]);
    expect(m.map((x) => x.type)).toEqual(["depart", "arrive"]);
    expect(m[0]?.distanceFromStartM).toBe(0);
    expect(m[1]?.distanceFromStartM).toBe(0);
  });

  it("straight line → no interior maneuvers", () => {
    const poly = buildCornerPolyline({ lat: 49, lng: 18 }, 10, 0, 10);
    const m = extractManeuvers(poly);
    expect(m.map((x) => x.type)).toEqual(["depart", "arrive"]);
  });

  it("90° right corner → turn-right with positive delta", () => {
    const poly = buildCornerPolyline({ lat: 49, lng: 18 }, 5, 90, 5);
    const m = extractManeuvers(poly);
    expect(m.map((x) => x.type)).toEqual(["depart", "turn-right", "arrive"]);
    expect(m[1]?.headingChangeDeg).toBeGreaterThan(80);
    expect(m[1]?.headingChangeDeg).toBeLessThan(100);
  });

  it("45° slight-left", () => {
    const poly = buildCornerPolyline({ lat: 49, lng: 18 }, 5, -30, 5);
    const m = extractManeuvers(poly);
    expect(m.map((x) => x.type)).toEqual([
      "depart",
      "turn-slight-left",
      "arrive",
    ]);
    expect(m[1]?.headingChangeDeg).toBeLessThan(0);
  });

  it("U-turn at ~170°", () => {
    const poly = buildCornerPolyline({ lat: 49, lng: 18 }, 5, 170, 5);
    const m = extractManeuvers(poly);
    expect(m[1]?.type).toBe("uturn");
  });

  it("attaches road names from the waypoint array", () => {
    const poly = buildCornerPolyline({ lat: 49, lng: 18 }, 5, 90, 5);
    const names = poly.map((_, i) =>
      i <= 5 ? "Main St" : i === poly.length - 1 ? "End" : "Side St",
    );
    const m = extractManeuvers(poly, names);
    const turn = m.find((x) => x.type === "turn-right");
    expect(turn?.roadName).toBeDefined();
    expect(turn?.roadName).toBe("Side St");
  });
});

describe("projectOnPolyline", () => {
  const poly: LatLng[] = [
    { lat: 49.5, lng: 18.0 },
    { lat: 49.5, lng: 18.01 },
    { lat: 49.5, lng: 18.02 },
  ];

  it("returns null for empty polyline", () => {
    expect(projectOnPolyline([], { lat: 49, lng: 18 })).toBeNull();
  });

  it("treats single-point polyline as a degenerate segment", () => {
    const p = projectOnPolyline([{ lat: 49.5, lng: 18.0 }], {
      lat: 49.5,
      lng: 18.01,
    });
    expect(p).not.toBeNull();
    expect(p?.progressM).toBe(0);
    expect(p?.distanceM).toBeGreaterThan(500);
  });

  it("projects a point exactly on the polyline with near-zero distance", () => {
    const p = projectOnPolyline(poly, { lat: 49.5, lng: 18.005 });
    expect(p?.distanceM).toBeLessThan(2);
    // Halfway through segment 0 → ~half of segment length cumulative.
    expect(p?.segmentIndex).toBe(0);
    expect(p?.progressM).toBeGreaterThan(300);
    expect(p?.progressM).toBeLessThan(500);
  });

  it("projects a point off the polyline to the nearest segment", () => {
    const p = projectOnPolyline(poly, { lat: 49.501, lng: 18.015 });
    expect(p?.distanceM).toBeGreaterThan(50);
    expect(p?.distanceM).toBeLessThan(200);
    expect(p?.segmentIndex).toBe(1);
  });

  it("clamps to polyline endpoints when the point is past the end", () => {
    const p = projectOnPolyline(poly, { lat: 49.5, lng: 18.1 });
    expect(p?.segmentIndex).toBe(1);
    // Clamped to the last vertex, so progress equals polyline length.
    const start = poly[0];
    const finish = poly[2];
    if (!start || !finish) throw new Error("poly fixture broken");
    const total = haversineM(start.lat, start.lng, finish.lat, finish.lng);
    expect(p?.progressM).toBeCloseTo(total, -1);
  });
});

describe("NavSession", () => {
  // Build a 1.5km L-shape: 500m east, right turn, 1000m south. Any tick
  // against this polyline should surface the single interior right turn.
  const poly = buildCornerPolyline({ lat: 49.5, lng: 18.0 }, 10, 90, 20);
  const maneuvers = extractManeuvers(poly);
  const executedTurn = maneuvers.find((m) => m.type === "turn-right");
  if (!executedTurn) throw new Error("test fixture broken: no turn");
  const startPt = poly[0];
  const endPt = poly[poly.length - 1];
  if (!startPt || !endPt)
    throw new Error("test fixture broken: empty polyline");

  it("fires depart on the first tick", () => {
    const s = new NavSession(poly, maneuvers);
    const tick = s.update(startPt);
    expect(tick.announcements.some((a) => a.type === "depart")).toBe(true);
    expect(tick.nextManeuver?.type).toBe("turn-right");
  });

  it("fires warning-far exactly once when crossing 300m to the turn", () => {
    const s = new NavSession(poly, maneuvers);
    s.update(startPt);
    // Walk along the polyline until the turn is within 300m. We pick a
    // point close to but below the threshold to trigger the boundary.
    const turnM = executedTurn.distanceFromStartM;
    const target = turnM - (WARNING_FAR_M - 10);
    const here = pointAlong(poly, target);
    const tick = s.update(here);
    expect(tick.announcements.map((a) => a.type)).toContain("warning-far");

    // Refires shouldn't happen on a nudge closer (still above near threshold).
    const here2 = pointAlong(poly, turnM - (WARNING_FAR_M - 40));
    const tick2 = s.update(here2);
    expect(tick2.announcements.map((a) => a.type)).not.toContain("warning-far");
  });

  it("fires warning-near, then arrived on completion", () => {
    const s = new NavSession(poly, maneuvers);
    s.update(startPt);
    // Skip past the far-warning zone so the near one is what fires here.
    s.update(pointAlong(poly, executedTurn.distanceFromStartM - 200));
    const near = s.update(
      pointAlong(poly, executedTurn.distanceFromStartM - (WARNING_NEAR_M - 5)),
    );
    expect(near.announcements.map((a) => a.type)).toContain("warning-near");

    // Arrival requires TWO consecutive in-zone ticks (guard against a
    // cold-start projection snapping to the tail on loop routes). The
    // first end-of-polyline tick primes prevInArrivalZone; the second
    // actually fires.
    const firstAtEnd = s.update(endPt);
    expect(firstAtEnd.announcements.map((a) => a.type)).not.toContain(
      "arrived",
    );
    const arrival = s.update(endPt);
    expect(arrival.announcements.map((a) => a.type)).toContain("arrived");
  });

  it("does not fire arrived on a single cold-start tick at the tail (loop-route guard)", () => {
    // Simulate the loop-route failure mode: the rider is at the start but
    // the projection snaps them to the end segment. A single tick must not
    // trigger the arrival announcement — the two-tick gate swallows it.
    const s = new NavSession(poly, maneuvers);
    const coldStart = s.update(endPt);
    expect(coldStart.announcements.map((a) => a.type)).not.toContain("arrived");
  });

  it("flags off-route when > 50m perpendicular and recovers on return", () => {
    const s = new NavSession(poly, maneuvers);
    s.update(startPt);
    // Offset 200m north of the first segment's mid-point — well over
    // the off-route threshold. We skip the maneuver logic while off-route.
    const offVertex = poly[2];
    const returnVertex = poly[3];
    if (!offVertex || !returnVertex) throw new Error("poly fixture broken");
    const offRouteTick = s.update({
      lat: offVertex.lat + 0.002,
      lng: offVertex.lng,
    });
    expect(offRouteTick.offRoute).toBe(true);
    expect(offRouteTick.announcements.map((a) => a.type)).toContain(
      "off-route",
    );

    const recovered = s.update(returnVertex);
    expect(recovered.offRoute).toBe(false);
    expect(recovered.announcements.map((a) => a.type)).toContain("on-route");
  });

  it("resets the arrival-zone history when off-route so recovery still needs two ticks", () => {
    // In-zone → off-route → in-zone must not fire `arrived` on the
    // single recovery tick. Without the reset, prevInArrivalZone would
    // stay true across the off-route gap and the two-tick gate would be
    // bypassed.
    const s = new NavSession(poly, maneuvers);
    s.update(startPt); // depart
    const end = endPt;
    // Tick 1: at the end (in-zone). Sets prevInArrivalZone=true but
    // doesn't fire since the prev was still false.
    const first = s.update(end);
    expect(first.announcements.map((a) => a.type)).not.toContain("arrived");

    // Tick 2: far north of the polyline — off-route. Should clear the
    // arrival-zone history.
    const offRoute = s.update({ lat: end.lat + 0.01, lng: end.lng });
    expect(offRoute.offRoute).toBe(true);

    // Tick 3: back on-route in the arrival zone. If the guard is
    // working, this alone is not enough to fire arrived.
    const recovery = s.update(end);
    expect(recovery.offRoute).toBe(false);
    expect(recovery.announcements.map((a) => a.type)).not.toContain("arrived");

    // Tick 4: still in the arrival zone — this is the second consecutive
    // on-route in-zone tick, so arrived finally fires.
    const arrival = s.update(end);
    expect(arrival.announcements.map((a) => a.type)).toContain("arrived");
  });

  it("collapses stacked thresholds on a cold-start fix inside the near window", () => {
    // Rider's first GPS fix lands 30m before the turn — below both the far
    // (300m) and near (50m) thresholds. We should hear ONE prompt (the most
    // urgent) rather than "In 0 meters, turn right" chased by "Turn right
    // now" on the same tick. The far threshold is silently marked fired so
    // a later tick doesn't rewind and announce the early warning.
    const s = new NavSession(poly, maneuvers);
    const turnM = executedTurn.distanceFromStartM;
    const tick = s.update(pointAlong(poly, turnM - 30));
    const thresholdKinds = tick.announcements
      .map((a) => a.type)
      .filter(
        (t) => t === "warning-far" || t === "warning-near" || t === "execute",
      );
    expect(thresholdKinds).toEqual(["warning-near"]);

    // And the far announcement must not resurrect on subsequent ticks.
    const later = s.update(pointAlong(poly, turnM - 20));
    expect(later.announcements.map((a) => a.type)).not.toContain("warning-far");
  });
});

describe("phraseForAnnouncement", () => {
  const sampleManeuver = {
    type: "turn-left" as const,
    vertexIndex: 5,
    distanceFromStartM: 400,
    headingChangeDeg: -80,
    roadName: "Hlavní",
  };

  it("rounds warning-far distances to the nearest 50m and appends road name", () => {
    expect(
      phraseForAnnouncement({
        type: "warning-far",
        maneuver: sampleManeuver,
        distanceM: 287,
      }),
    ).toBe("In 300 meters, turn left onto Hlavní.");
  });

  it("omits road name when unavailable and speaks near as imperative", () => {
    const noName = { ...sampleManeuver, roadName: undefined };
    expect(
      phraseForAnnouncement({
        type: "warning-near",
        maneuver: noName,
        distanceM: 30,
      }),
    ).toBe("Turn left now.");
  });

  it("suppresses 'onto {road}' when the turn stays on the current road", () => {
    // Case/whitespace-insensitive so "hlavní " == "Hlavní".
    expect(
      phraseForAnnouncement({
        type: "warning-far",
        maneuver: sampleManeuver,
        distanceM: 280,
        currentRoadName: "hlavní ",
      }),
    ).toBe("In 300 meters, turn left.");
  });

  it("returns null for execute so TTS doesn't fire during the turn itself", () => {
    expect(
      phraseForAnnouncement({
        type: "execute",
        maneuver: sampleManeuver,
        distanceM: 5,
      }),
    ).toBeNull();
  });

  it("departure and arrival phrases are self-contained", () => {
    expect(phraseForAnnouncement({ type: "depart" })).toBe(
      "Starting navigation.",
    );
    expect(phraseForAnnouncement({ type: "arrived" })).toBe(
      "You have arrived.",
    );
  });

  it("speaks imperial distances as yards rounded to the same 50 step", () => {
    expect(
      phraseForAnnouncement(
        {
          type: "warning-far",
          maneuver: sampleManeuver,
          distanceM: 287,
        },
        { unit: "imperial" },
      ),
    ).toBe("In 300 yards, turn left onto Hlavní.");
  });

  it("translates depart / arrive / off-route into Czech", () => {
    expect(phraseForAnnouncement({ type: "depart" }, { locale: "cs" })).toBe(
      "Spouštím navigaci.",
    );
    expect(phraseForAnnouncement({ type: "arrived" }, { locale: "cs" })).toBe(
      "Dorazili jste do cíle.",
    );
    expect(phraseForAnnouncement({ type: "off-route" }, { locale: "cs" })).toBe(
      "Sjeli jste z trasy.",
    );
  });

  it("translates a warning-far phrase with the maneuver and road name in Czech", () => {
    expect(
      phraseForAnnouncement(
        {
          type: "warning-far",
          maneuver: sampleManeuver,
          distanceM: 287,
        },
        { locale: "cs" },
      ),
    ).toBe("Za 300 metrů odbočte vlevo na Hlavní.");
  });

  it("preserves the German formal pronoun 'Sie' when splicing a turn mid-sentence", () => {
    // A blanket `.toLowerCase()` on the maneuver phrase would corrupt
    // "Halten Sie sich leicht links" into "halten sie sich leicht
    // links" — flipping the formal pronoun ("you") into "she/they"
    // and producing grammatically wrong German. The phrase builder
    // only lowercases the first character so mid-phrase
    // capitalisation that carries meaning is preserved.
    // (PR #509 review: bugbot low.)
    const slightLeft = {
      type: "turn-slight-left" as const,
      vertexIndex: 5,
      distanceFromStartM: 400,
      headingChangeDeg: -30,
    };
    expect(
      phraseForAnnouncement(
        {
          type: "warning-far",
          maneuver: slightLeft,
          distanceM: 287,
        },
        { locale: "de" },
      ),
    ).toBe("In 300 Metern halten Sie sich leicht links.");
  });

  it("appends a 'stay left' hint on a sharp left turn in verbose mode", () => {
    const sharp = {
      ...sampleManeuver,
      type: "turn-sharp-left" as const,
      headingChangeDeg: -130,
    };
    expect(
      phraseForAnnouncement({
        type: "warning-far",
        maneuver: sharp,
        distanceM: 280,
      }),
    ).toContain(", stay left");
  });

  it("concise mode strips 'onto X' filler and stay hints", () => {
    const sharp = {
      ...sampleManeuver,
      type: "turn-sharp-right" as const,
      headingChangeDeg: 130,
    };
    expect(
      phraseForAnnouncement(
        {
          type: "warning-far",
          maneuver: sharp,
          distanceM: 280,
        },
        { verbose: false },
      ),
    ).toBe("In 300 meters, sharp right.");
  });

  it("falls back to English when the locale has no translation table", () => {
    expect(
      phraseForAnnouncement(
        { type: "depart" },
        // @ts-expect-error — exercise the graceful fallback path
        { locale: "ja" },
      ),
    ).toBe("Starting navigation.");
  });
});

describe("announcementKey", () => {
  it("collapses warning-far and warning-near for the same maneuver", () => {
    const maneuver = {
      type: "turn-left" as const,
      vertexIndex: 12,
      distanceFromStartM: 800,
      headingChangeDeg: -60,
    };
    expect(
      announcementKey({ type: "warning-far", maneuver, distanceM: 280 }),
    ).toBe(
      announcementKey({
        type: "warning-near",
        maneuver,
        distanceM: 40,
      }),
    );
  });

  it("returns a category-scoped key for off-route / on-route transitions", () => {
    expect(announcementKey({ type: "off-route", distanceM: 80 })).toBe(
      "nav:off-route",
    );
    expect(announcementKey({ type: "on-route" })).toBe("nav:on-route");
  });
});

describe("resolveVoiceLocale", () => {
  it.each([
    ["cs_CZ", "cs"],
    ["sk-SK", "sk"],
    ["de-AT", "de"],
    ["en-US", "en"],
    ["en", "en"],
    ["fr-FR", "en"],
    ["", "en"],
    [undefined, "en"],
  ])("maps %s to %s", (input, expected) => {
    expect(resolveVoiceLocale(input as string | undefined)).toBe(expected);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Interpolate a point at `targetM` along a polyline. Used to drive the
 * session tick-by-tick without replaying the full polyline — we just
 * teleport the rider to the spot we want to test.
 */
function pointAlong(poly: LatLng[], targetM: number): LatLng {
  let remaining = targetM;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    if (!a || !b) continue;
    const len = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (remaining <= len) {
      const t = len === 0 ? 0 : remaining / len;
      return {
        lat: a.lat + t * (b.lat - a.lat),
        lng: a.lng + t * (b.lng - a.lng),
      };
    }
    remaining -= len;
  }
  const last = poly[poly.length - 1];
  if (!last) throw new Error("pointAlong: empty polyline");
  return last;
}
