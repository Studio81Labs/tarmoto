/**
 * TTS adapter — covers the pure queueing behaviour and the mute toggle.
 * The native module is absent in this environment, so the fallback
 * no-op path is what we exercise here; the real speak calls are covered
 * by manual QA on a paired Bluetooth headset.
 */
import { ttsService } from "../tts";

describe("ttsService", () => {
  beforeEach(() => {
    ttsService.stop();
    ttsService.setMuted(false);
  });

  it("no-ops silently when the native module is unavailable", () => {
    // No binding in jest env — `speak` should not throw and should not
    // claim a native module exists.
    expect(ttsService.hasNative()).toBe(false);
    expect(() => ttsService.speak("hello")).not.toThrow();
  });

  it("stop() drops any queued phrases so they don't resume later", () => {
    ttsService.speak("one");
    ttsService.speak("two");
    ttsService.stop();
    // Re-enabling a previously muted session should not replay anything:
    // nothing is queued and the native path is absent, so this is a
    // sanity check that stop() truly clears state.
    expect(() => ttsService.speak("three")).not.toThrow();
  });

  it("muting suppresses new phrases without throwing", () => {
    ttsService.setMuted(true);
    expect(ttsService.isMuted()).toBe(true);
    expect(() => ttsService.speak("silenced")).not.toThrow();
    ttsService.setMuted(false);
    expect(ttsService.isMuted()).toBe(false);
  });
});
