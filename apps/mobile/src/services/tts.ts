/**
 * TTS adapter for turn-by-turn navigation (US-16).
 *
 * Thin wrapper around `react-native-tts`:
 *
 *   - Lazy-requires the native module so this file stays importable in
 *     jest / web environments without the iOS/Android binding. When the
 *     module isn't available we fall back to a silent no-op so navigation
 *     still renders but doesn't crash.
 *
 *   - Serialises phrases through a small internal queue. Motorcycle voice
 *     prompts arrive back-to-back during a chain of maneuvers, and the
 *     underlying TTS engines drop overlapping `speak` calls if we don't
 *     wait for the previous one to finish.
 *
 *   - Exposes a global mute toggle so the NavigationScreen's voice FAB
 *     can suppress prompts without tearing down the session — the state
 *     machine still fires announcements, we just swallow them.
 *
 * Bluetooth output (AC #1 — "Clear voice prompts via Bluetooth headset")
 * is handled by the OS: once the motorcycle headset is paired and audio
 * is routed to it, `react-native-tts` plays through whatever the current
 * output device is. No extra work here.
 */

type TtsModule = {
  speak: (text: string, options?: unknown) => Promise<unknown>;
  stop: () => Promise<unknown> | void;
  addEventListener?: (
    event: "tts-finish" | "tts-cancel",
    listener: () => void,
  ) => unknown;
  removeAllListeners?: (
    event: "tts-finish" | "tts-cancel" | "tts-start",
  ) => void;
  setDefaultRate?: (rate: number, skipTransform?: boolean) => Promise<unknown>;
  setDefaultPitch?: (pitch: number) => Promise<unknown>;
  setDucking?: (enabled: boolean) => Promise<unknown>;
};

function loadTts(): TtsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-tts") as unknown;
    // The package ships a default export under CommonJS interop; also
    // tolerate the named import shape in case the library ever flips.
    if (mod && typeof mod === "object") {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      if (candidate && typeof (candidate as TtsModule).speak === "function") {
        return candidate as TtsModule;
      }
    }
  } catch {
    // Native module missing — jest, web preview, etc. Fall through.
  }
  return null;
}

class TtsService {
  private native: TtsModule | null = null;
  private queue: string[] = [];
  private speaking = false;
  private muted = false;
  private configured = false;

  private ensureNative(): TtsModule | null {
    if (this.native) return this.native;
    const mod = loadTts();
    if (!mod) return null;
    this.native = mod;
    this.configure(mod);
    return mod;
  }

  private configure(mod: TtsModule): void {
    if (this.configured) return;
    this.configured = true;
    // Slow down slightly — motorcycle wind noise makes the default rate
    // hard to parse through even a premium headset.
    void mod.setDefaultRate?.(0.5, true);
    void mod.setDefaultPitch?.(1.0);
    // Lower music/podcast volume while a prompt is speaking so the rider
    // doesn't miss a turn under loud audio. iOS-only; Android no-ops.
    void mod.setDucking?.(true);
  }

  private async drain(): Promise<void> {
    const mod = this.ensureNative();
    if (!mod) {
      this.queue = [];
      this.speaking = false;
      return;
    }
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) return;
    this.speaking = true;
    try {
      // `react-native-tts` resolves the `speak` promise when speech ends
      // (or the utterance is cancelled). Awaiting it directly keeps the
      // queue draining even when the native event listeners aren't wired,
      // which matters in environments where autolinking hasn't caught up.
      await mod.speak(next);
    } catch {
      // If the native side throws (e.g. audio session denied), drop the
      // phrase and keep going. A retry loop would just pile up.
    } finally {
      this.speaking = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  /**
   * Enqueue a phrase. If the service is muted or the native module is
   * unavailable, the call is a silent no-op. If the most recent queued
   * phrase is identical, we dedupe to avoid back-to-back repeats when a
   * GPS tick re-fires an announcement that should have been one-shot.
   */
  speak(phrase: string): void {
    if (this.muted) return;
    const mod = this.ensureNative();
    if (!mod) return;
    const last = this.queue[this.queue.length - 1];
    if (last === phrase) return;
    this.queue.push(phrase);
    void this.drain();
  }

  /** Immediately stop the current phrase and clear the queue. */
  stop(): void {
    this.queue = [];
    this.speaking = false;
    const mod = this.ensureNative();
    if (mod) {
      void Promise.resolve(mod.stop()).catch(() => {
        /* ignore */
      });
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** True when a real native TTS binding is available. Used by tests. */
  hasNative(): boolean {
    return this.ensureNative() !== null;
  }
}

export const ttsService = new TtsService();
