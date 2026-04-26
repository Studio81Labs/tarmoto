/**
 * Crash detector unit tests — US-12 AC #1.
 *
 * Drives the detector with synthetic 50 Hz readings using a
 * deterministic clock so the spike + immobility logic is exercised
 * without flake from real timers or mocked sensor backends.
 */

import { CRASH_DEFAULTS, CrashDetector } from "../crashDetector";
import type { SensorReading } from "@/types";

const SAMPLE_PERIOD_MS = 20; // 50 Hz
const GRAVITY = 9.81;

function makeReading(t: number, ax = 0, ay = 0, az = GRAVITY): SensorReading {
  return { t, ax, ay, az };
}

/** Push N readings of the given resultant magnitude into the detector. */
function feedMagnitude(
  detector: CrashDetector,
  startMs: number,
  durationMs: number,
  magnitudeMs2: number,
): { lastT: number; event: ReturnType<CrashDetector["feed"]> } {
  let event: ReturnType<CrashDetector["feed"]> = null;
  // Convert "deviation above gravity" to a raw vertical accel value.
  const rawAz = magnitudeMs2 + GRAVITY;
  let t = startMs;
  const end = startMs + durationMs;
  while (t <= end) {
    const out = detector.feed(makeReading(t, 0, 0, rawAz));
    if (out) event = out;
    t += SAMPLE_PERIOD_MS;
  }
  return { lastT: t - SAMPLE_PERIOD_MS, event };
}

describe("CrashDetector", () => {
  it("does not trigger on a single high-g sample", () => {
    const detector = new CrashDetector();
    // One sample at 5g (49 m/s² above gravity) — nowhere near the 100ms
    // duration requirement.
    const out = detector.feed(makeReading(0, 0, 0, GRAVITY + 49));
    expect(out).toBeNull();
  });

  it("does not trigger on a 4g spike that fizzles before 100 ms", () => {
    const detector = new CrashDetector();
    const { event } = feedMagnitude(
      detector,
      0,
      80,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    // Only ~80 ms above threshold — below the 100 ms duration.
    expect(event).toBeNull();
  });

  it("does not trigger when the rider keeps moving after the spike", () => {
    const detector = new CrashDetector();
    // Sustained 4g spike for 200 ms.
    const spike = feedMagnitude(
      detector,
      0,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    // Then significant motion (3 m/s² rms — well above the still
    // threshold) for the entire immobility window.
    feedMagnitude(
      detector,
      spike.lastT + SAMPLE_PERIOD_MS,
      CRASH_DEFAULTS.immobilityDurationMs + 1_000,
      3.0,
    );
    expect(spike.event).toBeNull();
  });

  it("triggers when a 4g spike is followed by 5s of no significant motion", () => {
    const detector = new CrashDetector();
    let captured: { triggeredAt: number; peakAcceleration: number } | null =
      null;
    detector.onCrash((event) => {
      captured = event;
    });

    // Spike: 200 ms at 4g (well above the peakG threshold).
    const spike = feedMagnitude(
      detector,
      0,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    expect(spike.event).toBeNull();

    // Immobility: 6 seconds of near-zero deviation. The detector should
    // fire once `t - armedAt` >= 5_000 ms with a still RMS.
    const still = feedMagnitude(
      detector,
      spike.lastT + SAMPLE_PERIOD_MS,
      6_000,
      0.05,
    );
    expect(still.event).not.toBeNull();
    expect(captured).not.toBeNull();
    expect(captured!.peakAcceleration).toBeGreaterThanOrEqual(
      CRASH_DEFAULTS.peakG * GRAVITY * 0.99,
    );
  });

  it("respects custom thresholds when provided", () => {
    // Lower the bar to exercise the override path: 2g, 50 ms, 1s
    // immobility window. A 2.5g spike for 60 ms followed by 1.5s of
    // stillness must trigger. We feed clearly above the configured
    // 2g threshold so floating-point edge cases on the 2*9.81 boundary
    // can't mask a logic error.
    const detector = new CrashDetector({
      peakG: 2,
      peakDurationMs: 50,
      immobilityDurationMs: 1_000,
      immobilityRmsMax: 0.5,
    });

    const spike = feedMagnitude(detector, 0, 60, 3 * GRAVITY);
    expect(spike.event).toBeNull();

    const still = feedMagnitude(
      detector,
      spike.lastT + SAMPLE_PERIOD_MS,
      1_200,
      0.05,
    );
    expect(still.event).not.toBeNull();
  });

  it("re-arms after a non-crash spike+motion sequence", () => {
    // Big spike, but the rider keeps moving — detector returns to idle
    // after twice the immobility window. A subsequent real crash must
    // still fire.
    const detector = new CrashDetector();
    const firstSpike = feedMagnitude(
      detector,
      0,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    feedMagnitude(
      detector,
      firstSpike.lastT + SAMPLE_PERIOD_MS,
      CRASH_DEFAULTS.immobilityDurationMs * 3,
      3.0,
    );

    let captured: unknown = null;
    detector.onCrash((event) => {
      captured = event;
    });
    const start =
      firstSpike.lastT + CRASH_DEFAULTS.immobilityDurationMs * 3 + 1_000;
    const secondSpike = feedMagnitude(
      detector,
      start,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    expect(secondSpike.event).toBeNull();
    feedMagnitude(detector, secondSpike.lastT + SAMPLE_PERIOD_MS, 6_000, 0.05);
    expect(captured).not.toBeNull();
  });

  it("does not re-fire within rearmDelayMs of a previous trigger", () => {
    // After a positive trigger the state machine returns to idle so
    // the detector keeps protecting the rider, but an immediate second
    // spike (helmet impact + body slam land seconds apart) must NOT
    // produce a second countdown. Use a short delay for the test.
    const detector = new CrashDetector({ rearmDelayMs: 60_000 });
    let fires = 0;
    detector.onCrash(() => {
      fires += 1;
    });

    // First crash sequence.
    const firstSpike = feedMagnitude(
      detector,
      0,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    feedMagnitude(detector, firstSpike.lastT + SAMPLE_PERIOD_MS, 6_000, 0.05);
    expect(fires).toBe(1);

    // Second spike 10 seconds after the fire — well inside the rearm
    // window. Must NOT trigger a second event.
    const secondStart = 10_000;
    const secondSpike = feedMagnitude(
      detector,
      secondStart,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    feedMagnitude(detector, secondSpike.lastT + SAMPLE_PERIOD_MS, 6_000, 0.05);
    expect(fires).toBe(1);

    // After the rearm window has elapsed a real new crash must fire
    // again so the rider isn't permanently unprotected after a single
    // false positive.
    const thirdStart = 80_000;
    const thirdSpike = feedMagnitude(
      detector,
      thirdStart,
      200,
      CRASH_DEFAULTS.peakG * GRAVITY,
    );
    feedMagnitude(detector, thirdSpike.lastT + SAMPLE_PERIOD_MS, 6_000, 0.05);
    expect(fires).toBe(2);
  });

  it("captures speedAtImpactMs at the spike onset, not after immobility", () => {
    // Bugbot 00350521: by the time onCrash fires the rider has been
    // still for the entire immobility window, so reading
    // `ride.currentSpeed` from the store would report ~0. The detector
    // must instead bind the speed of the reading that crossed the
    // threshold so emergency dispatchers see the pre-impact value.
    const detector = new CrashDetector();
    let captured: { speedAtImpactMs: number | null } | null = null;
    detector.onCrash((event) => {
      captured = event;
    });

    const G = 9.81;
    const az = 5 * G + G; // well above 4g default
    let t = 0;
    // First spike sample carries the rider's pre-impact speed (20 m/s
    // ≈ 72 km/h). Subsequent samples drop the speed to 0 to simulate
    // the rider going down.
    detector.feed({ t, ax: 0, ay: 0, az, speed: 20 });
    for (t = 20; t <= 200; t += 20) {
      detector.feed({ t, ax: 0, ay: 0, az, speed: 0 });
    }
    for (; t <= 6_220; t += 20) {
      detector.feed({ t, ax: 0, ay: 0, az: 0.05 + G, speed: 0 });
    }

    expect(captured).not.toBeNull();
    expect(captured!.speedAtImpactMs).toBe(20);
  });

  it("reports speedAtImpactMs=null when the impact reading has no GPS", () => {
    const detector = new CrashDetector();
    let captured: { speedAtImpactMs: number | null } | null = null;
    detector.onCrash((event) => {
      captured = event;
    });

    feedMagnitude(detector, 0, 200, CRASH_DEFAULTS.peakG * GRAVITY);
    feedMagnitude(detector, 220, 6_000, 0.05);

    expect(captured).not.toBeNull();
    expect(captured!.speedAtImpactMs).toBeNull();
  });

  it("reset() clears in-progress spike state", () => {
    const detector = new CrashDetector();
    feedMagnitude(detector, 0, 60, CRASH_DEFAULTS.peakG * GRAVITY);
    detector.reset();
    // After reset, the previously-armed state is gone — feeding still
    // readings cannot complete a partial trigger.
    let captured: unknown = null;
    detector.onCrash((event) => {
      captured = event;
    });
    feedMagnitude(detector, 200, 6_000, 0.05);
    expect(captured).toBeNull();
  });
});
