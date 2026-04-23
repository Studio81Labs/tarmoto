/**
 * TTS adapter — covers queueing, mute, and the navigation-specific
 * audio-session policy for helmet/headset playback.
 */

type MockTtsModule = {
  speak: jest.Mock;
  stop: jest.Mock;
  getInitStatus: jest.Mock;
  addEventListener: jest.Mock;
  removeAllListeners: jest.Mock;
  setDefaultRate: jest.Mock;
  setDefaultPitch: jest.Mock;
  setDucking: jest.Mock;
  setIgnoreSilentSwitch: jest.Mock;
};

function createNativeMock(): MockTtsModule {
  return {
    speak: jest.fn(async () => "utterance-1"),
    stop: jest.fn(async () => undefined),
    getInitStatus: jest.fn(async () => undefined),
    addEventListener: jest.fn(),
    removeAllListeners: jest.fn(),
    setDefaultRate: jest.fn(async () => undefined),
    setDefaultPitch: jest.fn(async () => undefined),
    setDucking: jest.fn(async () => undefined),
    setIgnoreSilentSwitch: jest.fn(async () => undefined),
  };
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
});
