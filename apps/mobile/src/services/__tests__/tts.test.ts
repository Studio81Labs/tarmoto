/**
 * TTS adapter — covers queueing, mute, and the navigation-specific
 * audio-session policy for helmet/headset playback.
 */

type EventListenerMap = Partial<Record<string, () => void>>;

type MockTtsModule = {
  speak: jest.Mock;
  stop: jest.Mock;
  getInitStatus: jest.Mock;
  addEventListener: jest.Mock;
  removeAllListeners: jest.Mock;
  setDefaultRate: jest.Mock;
  setDefaultPitch: jest.Mock;
  setDefaultLanguage: jest.Mock;
  setDucking: jest.Mock;
  setIgnoreSilentSwitch: jest.Mock;
  __listeners: EventListenerMap;
  __fireFinish: () => void;
};

function createNativeMock(): MockTtsModule {
  const listeners: EventListenerMap = {};
  const mock: MockTtsModule = {
    speak: jest.fn(async () => "utterance-1"),
    stop: jest.fn(async () => undefined),
    getInitStatus: jest.fn(async () => undefined),
    addEventListener: jest.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
    removeAllListeners: jest.fn(),
    setDefaultRate: jest.fn(async () => undefined),
    setDefaultPitch: jest.fn(async () => undefined),
    setDefaultLanguage: jest.fn(async () => undefined),
    setDucking: jest.fn(async () => undefined),
    setIgnoreSilentSwitch: jest.fn(async () => undefined),
    __listeners: listeners,
    __fireFinish: () => {
      listeners["tts-finish"]?.();
    },
  };
  return mock;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function loadService(options?: {
  platform?: "ios" | "android";
  nativeModule?: MockTtsModule | null;
}) {
  const platform = options?.platform ?? "android";
  const nativeModule = options?.nativeModule ?? null;

  jest.resetModules();

  jest.doMock("react-native", () => ({
    Platform: {
      OS: platform,
    },
  }));

  if (nativeModule) {
    jest.doMock("react-native-tts", () => ({
      __esModule: true,
      default: nativeModule,
    }));
  } else {
    jest.doMock("react-native-tts", () => ({
      __esModule: true,
      default: {},
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ttsService } = require("../tts") as typeof import("../tts");
  return { ttsService, nativeModule };
}

describe("ttsService", () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock("react-native");
    jest.unmock("react-native-tts");
  });

  it("no-ops silently when the native module is unavailable", () => {
    const { ttsService } = loadService();

    expect(ttsService.hasNative()).toBe(false);
    expect(() => ttsService.speak("hello")).not.toThrow();
  });

  it("configures iOS playback to ignore the silent switch for nav prompts", () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "ios", nativeModule });

    expect(ttsService.hasNative()).toBe(true);
    expect(nativeModule.setDefaultRate).toHaveBeenCalledWith(0.5, true);
    expect(nativeModule.setDefaultPitch).toHaveBeenCalledWith(1.0);
    expect(nativeModule.setDucking).toHaveBeenCalledWith(true);
    expect(nativeModule.setIgnoreSilentSwitch).toHaveBeenCalledWith("ignore");
  });

  it("routes Android prompts through the voice-call stream for helmet headsets", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Turn right in 300 meters");
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledWith(
      "Turn right in 300 meters",
      expect.objectContaining({
        androidParams: expect.objectContaining({
          KEY_PARAM_STREAM: "STREAM_VOICE_CALL",
        }),
      }),
    );
  });

  it("stop() drops any queued phrases so they don't resume later", () => {
    const { ttsService } = loadService();

    ttsService.speak("one");
    ttsService.speak("two");
    ttsService.stop();

    expect(() => ttsService.speak("three")).not.toThrow();
  });

  it("muting suppresses new phrases without throwing", () => {
    const { ttsService } = loadService();

    ttsService.setMuted(true);
    expect(ttsService.isMuted()).toBe(true);
    expect(() => ttsService.speak("silenced")).not.toThrow();
    ttsService.setMuted(false);
    expect(ttsService.isMuted()).toBe(false);
  });

  it("collapses a stale 'in 300m' against a fresh 'in 50m' for the same maneuver", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    // First phrase starts speaking immediately and isn't queue-replaceable —
    // it's already in flight. The follow-up far + near for the SAME
    // maneuver enqueue with the same key, and the second one replaces
    // the first in the queue rather than appending.
    ttsService.speak("Starting navigation.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    ttsService.speak("In 300 meters, turn left.", { key: "nav:warning:5" });
    ttsService.speak("Turn left now.", { key: "nav:warning:5" });

    // Drain the in-flight starting prompt — only the collapsed
    // "Turn left now" survives in the queue.
    nativeModule.__fireFinish();
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(2);
    expect(nativeModule.speak.mock.calls[1][0]).toBe("Turn left now.");
  });

  it("high-priority phrases preempt an in-flight normal-priority utterance", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    ttsService.speak("Crash detected. Tap I'm OK to cancel.", {
      priority: "high",
    });
    await flushMicrotasks();

    // The high-priority phrase should have called stop() on the
    // in-flight utterance and pushed itself to the front of the queue.
    expect(nativeModule.stop).toHaveBeenCalled();
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);
    expect(nativeModule.speak.mock.calls[1][0]).toContain("Crash detected");
  });

  it("stopNavigation cuts an in-flight navigation prompt", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("In 300 meters, turn left."); // normal priority
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    nativeModule.stop.mockClear();

    ttsService.stopNavigation();
    expect(nativeModule.stop).toHaveBeenCalled();
  });

  it("stopNavigation preserves an in-flight high-priority safety alert", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    // A crash SOS countdown is playing when navigation tears down.
    ttsService.speak("Crash detected. Tap I'm OK to cancel.", {
      priority: "high",
    });
    await flushMicrotasks();
    nativeModule.stop.mockClear();

    ttsService.stopNavigation();

    // The safety lane must keep speaking — no preempt of a high-priority phrase.
    expect(nativeModule.stop).not.toHaveBeenCalled();
  });

  it("cancelByKeyPrefix cancels an in-flight utterance matching the prefix", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:42",
    });
    await flushMicrotasks();
    nativeModule.stop.mockClear();

    ttsService.cancelByKeyPrefix("weather:");
    expect(nativeModule.stop).toHaveBeenCalled();
  });

  it("cancelByKeyPrefix drains a queued safety alert after cancelling the in-flight match", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    // Weather warning speaking, crash countdown queued behind it (both high
    // priority — the second doesn't preempt the first, it queues).
    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:1",
    });
    await flushMicrotasks();
    ttsService.speak("Crash detected. Tap I'm OK to cancel.", {
      priority: "high",
      key: "crash:countdown",
    });
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    // weather_alerts killed → cancel the in-flight weather phrase; the queued
    // crash countdown MUST then drain and speak (not sit unspoken forever).
    ttsService.cancelByKeyPrefix("weather:");
    await flushMicrotasks();

    expect(nativeModule.speak.mock.calls.map((c) => c[0])).toEqual([
      "Severe storm ahead.",
      "Crash detected. Tap I'm OK to cancel.",
    ]);
  });

  it("cancelByKeyPrefix leaves a non-matching in-flight utterance (crash) untouched", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    // A crash countdown shares the high-priority lane but a different key.
    ttsService.speak("Crash detected. Tap I'm OK to cancel.", {
      priority: "high",
      key: "crash:countdown",
    });
    await flushMicrotasks();
    nativeModule.stop.mockClear();

    ttsService.cancelByKeyPrefix("weather:");
    expect(nativeModule.stop).not.toHaveBeenCalled();
  });

  it("drops queued normal-priority phrases when a high-priority alert fires", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Starting navigation.");
    ttsService.speak("Continue.");
    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    ttsService.speak("Severe storm ahead.", { priority: "high" });
    await flushMicrotasks();

    nativeModule.__fireFinish();
    await flushMicrotasks();

    // After the high-priority alert finishes, no stale nav prompt
    // should resurrect — the queue was purged.
    expect(nativeModule.speak.mock.calls.map((c) => c[0])).toEqual([
      "Starting navigation.",
      "Severe storm ahead.",
    ]);
  });

  it("a high-priority phrase already speaking is not preempted by another", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();
    nativeModule.stop.mockClear();

    ttsService.speak("Severe storm ahead.", { priority: "high" });
    await flushMicrotasks();

    // The second high-priority phrase queues behind the first instead
    // of cutting it off.
    expect(nativeModule.stop).not.toHaveBeenCalled();
    nativeModule.__fireFinish();
    await flushMicrotasks();

    expect(nativeModule.speak.mock.calls.map((c) => c[0])).toEqual([
      "Crash detected.",
      "Severe storm ahead.",
    ]);
  });

  it("pause() suppresses queued phrases until resume()", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.pause();
    expect(ttsService.isPaused()).toBe(true);

    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    // Nothing speaks while paused — the phrase is queued but the drain
    // is gated behind the paused flag.
    expect(nativeModule.speak).not.toHaveBeenCalled();

    ttsService.resume();
    await flushMicrotasks();
    expect(ttsService.isPaused()).toBe(false);
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
  });

  it("setExternalAudioActive(true) suppresses normal-priority TTS while CarPlay owns audio", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setExternalAudioActive(true);
    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    expect(nativeModule.speak).not.toHaveBeenCalled();

    ttsService.setExternalAudioActive(false);
    ttsService.speak("Continue.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Continue.");
  });

  it("never suppresses high-priority safety alerts even while CarPlay owns audio", async () => {
    // The head unit doesn't surface crash / critical weather alerts —
    // dropping them on a connected bike would silently silence the
    // safety-critical channel exactly when the rider can't reach the
    // phone. (PR #509 review: bugbot, codex P1.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setExternalAudioActive(true);
    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Crash detected.");
  });

  it("dedupes a re-fired high-priority alert against its key", async () => {
    // A weather poll that re-emits the same critical alert (same key)
    // shouldn't stack two identical entries behind the in-flight one.
    // (PR #509 review: codex P2.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();
    nativeModule.speak.mockClear();

    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:storm-1",
    });
    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:storm-1",
    });

    nativeModule.__fireFinish();
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Severe storm ahead.");
  });

  it("setLanguage() forwards a BCP-47 tag to the engine", () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setLanguage("cs-CZ");
    expect(nativeModule.setDefaultLanguage).toHaveBeenCalledWith("cs-CZ");
  });

  it("setVolume() drives the Android per-utterance volume parameter", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setVolume(0.42);
    ttsService.speak("hello");
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        androidParams: expect.objectContaining({
          KEY_PARAM_VOLUME: 0.42,
        }),
      }),
    );
  });

  it("setVolume() clamps out-of-range values to [0, 1]", () => {
    const { ttsService } = loadService();

    ttsService.setVolume(-1);
    expect(ttsService.getVolume()).toBe(0);
    ttsService.setVolume(7);
    expect(ttsService.getVolume()).toBe(1);
    ttsService.setVolume(Number.NaN);
    expect(ttsService.getVolume()).toBe(1);
  });

  it("setVolume(0) purges queued normal-priority phrases on iOS", async () => {
    // Without the purge, queued phrases would still drain after the
    // rider picked Settings "Mute" — silently on Android via
    // KEY_PARAM_VOLUME=0 but audibly on iOS (no per-utterance volume).
    // (PR #509 review: bugbot low.) High-priority alerts must stay on
    // the queue.
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "ios", nativeModule });

    ttsService.speak("Continue.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    ttsService.speak("In 300 meters, turn left.");
    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:1",
    });

    ttsService.setVolume(0);
    // The setVolume itself preempted the in-flight normal-priority
    // utterance. Consume that cancel.
    nativeModule.__fireFinish();
    await flushMicrotasks();

    // Only the high-priority alert should drain; the queued normal
    // phrase should have been purged.
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);
    expect(nativeModule.speak.mock.calls[1][0]).toBe("Severe storm ahead.");

    // Subsequent normal-priority phrases keep being suppressed while
    // volume stays 0.
    ttsService.speak("Turn left now.");
    nativeModule.__fireFinish();
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);
  });

  it("treats volume 0 as a hard mute for normal-priority speech (iOS parity)", async () => {
    // iOS has no per-utterance volume on react-native-tts, so the
    // Android-only `KEY_PARAM_VOLUME` path would otherwise leave the
    // Settings "Mute" bucket inaudible only on Android. Suppressing at
    // the service level keeps the contract identical across platforms.
    // (PR #509 review: codex P2.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "ios", nativeModule });

    ttsService.setVolume(0);
    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    expect(nativeModule.speak).not.toHaveBeenCalled();

    ttsService.setVolume(0.5);
    ttsService.speak("Continue.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
  });

  it("high-priority safety alerts bypass the voice-FAB mute", async () => {
    // The voice FAB on NavigationScreen labels itself as muting voice
    // GUIDANCE; safety-critical alerts must still reach the rider.
    // (PR #509 review: codex P1.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setMuted(true);
    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Crash detected.");
  });

  it("high-priority safety alerts bypass volume=0 mute on iOS", async () => {
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "ios", nativeModule });

    ttsService.setVolume(0);
    ttsService.speak("Severe storm ahead.", { priority: "high" });
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
  });

  it("high-priority alerts override KEY_PARAM_VOLUME=0 to full volume on Android", async () => {
    // Without the override, a high-priority alert hits the engine
    // with KEY_PARAM_VOLUME: 0 and is silent at the native side even
    // though speak() correctly bypassed the volume<=0 suppression.
    // (PR #509 review: bugbot high.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.setVolume(0);
    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();

    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak).toHaveBeenCalledWith(
      "Crash detected.",
      expect.objectContaining({
        androidParams: expect.objectContaining({ KEY_PARAM_VOLUME: 1 }),
      }),
    );

    // Drain the high-priority alert so the next normal phrase can
    // run, then assert normal-priority speech still honours the
    // rider's volume slider (only the high-priority bucket forces
    // full volume).
    nativeModule.__fireFinish();
    await flushMicrotasks();
    nativeModule.speak.mockClear();
    ttsService.setVolume(0.42);
    ttsService.speak("Continue.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledWith(
      "Continue.",
      expect.objectContaining({
        androidParams: expect.objectContaining({ KEY_PARAM_VOLUME: 0.42 }),
      }),
    );
  });

  it("preempt during cold-start init does not orphan a pendingDiscard", async () => {
    // Repro for the cold-start race: drain() flips `speaking=true`
    // before awaiting `getInitStatus()`. If a preempt lands in that
    // window, no native utterance has been submitted yet — `mod.stop()`
    // has nothing to cancel, so no `tts-cancel` event will fire.
    // Without the `speakingNative` gate, the preempt would still
    // increment `pendingDiscards`, and the orphaned count would
    // swallow the NEXT real `tts-finish`, freezing the queue with
    // `speaking=true`. (PR #509 review: codex P2.)
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    const nativeModule = createNativeMock();
    nativeModule.getInitStatus.mockImplementation(() => initPromise);

    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    // Still gated on getInitStatus — nothing has been submitted yet.
    expect(nativeModule.speak).not.toHaveBeenCalled();

    // Preempt before submission. With the fix this records no discard.
    ttsService.speak("Crash detected.", { priority: "high" });
    await flushMicrotasks();

    // Release the init gate so both drains can proceed.
    resolveInit();
    await flushMicrotasks();
    await flushMicrotasks();

    // Only the high-priority phrase reaches native — the original turn
    // cue was preempted before submission.
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Crash detected.");

    // The high-priority utterance finishes naturally. Without the fix,
    // an orphaned pendingDiscard would swallow this finish and keep
    // `speaking=true`, blocking every later prompt.
    nativeModule.__fireFinish();
    await flushMicrotasks();

    // Follow-up normal-priority phrase should drain cleanly.
    ttsService.speak("Continue.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);
    expect(nativeModule.speak.mock.calls[1][0]).toBe("Continue.");
  });

  it("setMuted(true) preserves queued high-priority alerts", async () => {
    // Muting voice guidance shouldn't drop a queued crash/weather
    // alert — the FAB silences turn cues, not safety notices.
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("Continue.");
    await flushMicrotasks();
    nativeModule.speak.mockClear();

    ttsService.speak("In 300 meters, turn left.");
    ttsService.speak("Severe storm ahead.", { priority: "high" });

    ttsService.setMuted(true);
    // The setMuted itself preempted the in-flight normal-priority
    // utterance; consume that cancel before the next assertions.
    nativeModule.__fireFinish();
    await flushMicrotasks();

    // The high-priority alert should still drain even though we're
    // muted.
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);
    expect(nativeModule.speak.mock.calls[0][0]).toBe("Severe storm ahead.");
  });

  it("preempt cancel doesn't end the new high-priority utterance", async () => {
    // Regression for the stale-cancel race: bumping epoch + draining a
    // new utterance synchronously left `speakingEpoch === epoch`, so a
    // late cancel from the stopped utterance was treated as the new
    // one finishing. Result: a queued second high-priority alert
    // overlapped with the in-flight one. The pendingDiscards counter
    // closes that window. (PR #509 review: bugbot medium.)
    const nativeModule = createNativeMock();
    const { ttsService } = loadService({ platform: "android", nativeModule });

    ttsService.speak("In 300 meters, turn left.");
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(1);

    ttsService.speak("Crash detected.", {
      priority: "high",
      key: "crash:1",
    });
    await flushMicrotasks();
    // The crash alert should now be in flight — speak called twice
    // total (the original turn cue, then the crash alert).
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);

    // A second high-priority alert queues behind the first.
    ttsService.speak("Severe storm ahead.", {
      priority: "high",
      key: "weather:1",
    });

    // The native side now fires the cancel for the ORIGINAL turn cue
    // we preempted. Without pendingDiscards, this would flip
    // `speaking` off and immediately drain the queued storm alert,
    // overlapping it with the in-flight crash countdown.
    nativeModule.__fireFinish();
    await flushMicrotasks();
    // Crash alert is still considered "in flight" — we didn't drain
    // the storm alert yet.
    expect(nativeModule.speak).toHaveBeenCalledTimes(2);

    // Crash alert finishes naturally; storm alert drains.
    nativeModule.__fireFinish();
    await flushMicrotasks();
    expect(nativeModule.speak).toHaveBeenCalledTimes(3);
    expect(nativeModule.speak.mock.calls[2][0]).toBe("Severe storm ahead.");
  });
});
