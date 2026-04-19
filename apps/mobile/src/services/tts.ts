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
 *   - Serialises phrases through a small internal queue. `react-native-tts`
 *     documents `speak()` as resolving with the utteranceId once the
 *     phrase is queued, not when playback ends — so we drive the drain
 *     from the `tts-finish` / `tts-cancel` events instead of awaiting the
 *     `speak()` promise (which would fire the next phrase over the top of
 *     the previous one on every device).
 *
 *   - Gates the first enqueue on `getInitStatus()` so the initial prompt
 *     doesn't get dropped on a cold start (Android in particular may still
 *     be spinning up the engine when the first announcement fires).
 *
 *   - Exposes a global mute toggle so the NavigationScreen's voice FAB
 *     can suppress prompts without tearing down the session — the state
 *     machine still fires announcements, we just swallow them.
 *
 *   - Uses a monotonic "epoch" counter to distinguish a stale in-flight
 *     utterance (cancelled by `stop()`) from a fresh one. The native
 *     `tts-cancel` event might arrive after a new `speak()` has already
 *     started — without the epoch the listener would flip `speaking` to
 *     false mid-new-utterance and let the drain pull a third one over
 *     the top.
 *
 * Bluetooth output (AC #1 — "Clear voice prompts via Bluetooth headset")
 * is handled by the OS: once the motorcycle headset is paired and audio
 * is routed to it, `react-native-tts` plays through whatever the current
 * output device is. No extra work here.
 */

type TtsEvent = "tts-finish" | "tts-cancel" | "tts-start";

type TtsModule = {
  speak: (text: string, options?: unknown) => Promise<unknown>;
  stop: () => Promise<unknown> | void;
  getInitStatus?: () => Promise<unknown>;
  addEventListener?: (event: TtsEvent, listener: () => void) => unknown;
  removeAllListeners?: (event: TtsEvent) => void;
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
  private ready: Promise<void> | null = null;
  // Incremented by `stop()`. Any completion listener belonging to a prior
  // epoch is ignored, so a late `tts-cancel` event from a stopped run
  // can't flip `speaking` off while a fresh utterance is playing. The
  // currently-speaking utterance tags itself with `speakingEpoch`; the
  // finish/cancel handler ignores any event whose epoch no longer matches.
  private epoch = 0;
  private speakingEpoch = 0;

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
    // Both `tts-finish` and `tts-cancel` mean "the current utterance is
    // done" — let the drain pull the next phrase. We don't distinguish
    // them at the queue level since either way nothing is speaking.
    mod.addEventListener?.("tts-finish", this.handleUtteranceEnded);
    mod.addEventListener?.("tts-cancel", this.handleUtteranceEnded);
  }

  private handleUtteranceEnded = (): void => {
    // Ignore listeners left over from a stopped run — `stop()` bumps the
    // epoch, so any cancel event that fires after the queue has been
    // cleared belongs to a prior utterance and mustn't touch `speaking`
    // while a fresh one is already in flight.
    if (this.speakingEpoch !== this.epoch) return;
    this.speaking = false;
    void this.drain();
  };

  /**
   * Resolve once the native TTS engine reports ready. Some platforms (and
   * some Android OEM engines in particular) drop the very first
   * `speak()` call if they're still initializing — gating behind
   * `getInitStatus()` closes that window. Subsequent calls reuse the
   * cached promise so we don't re-probe on every phrase.
   */
  private async waitForReady(mod: TtsModule): Promise<void> {
    if (!this.ready) {
      if (typeof mod.getInitStatus === "function") {
        this.ready = Promise.resolve(mod.getInitStatus()).then(
          () => undefined,
          // `getInitStatus` can reject with `{ code: "no_engine" }` on
          // Android without a TTS engine installed. The wrapped promise
          // still resolves so the queue keeps draining — the native
          // `speak` calls will simply no-op, which matches the silent-
          // fallback behaviour we promise elsewhere.
          () => undefined,
        );
      } else {
        this.ready = Promise.resolve();
      }
    }
    return this.ready;
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
    if (next === undefined) return;
    this.speaking = true;
    const epochAtStart = this.epoch;
    this.speakingEpoch = epochAtStart;
    try {
      await this.waitForReady(mod);
      if (this.epoch !== epochAtStart) return; // stopped while we waited
      // Don't await for playback — `speak()` resolves with an utterance
      // id immediately on every published version of the library. The
      // `tts-finish` / `tts-cancel` listener above is what drives the
      // next drain.
      await mod.speak(next);
    } catch {
      // If the native side throws synchronously (audio session denied,
      // invalid voice id, etc.) we'll never get a finish event for this
      // utterance, so unblock the queue ourselves.
      if (this.epoch === epochAtStart) {
        this.speaking = false;
        if (this.queue.length > 0) void this.drain();
      }
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

  /**
   * Immediately stop the current phrase and clear the queue. Bumps the
   * epoch so any late `tts-finish`/`tts-cancel` listener from the
   * interrupted utterance becomes a no-op on arrival, closing the race
   * that would otherwise let a stale event flip `speaking` off while a
   * fresh phrase had already taken its place.
   */
  stop(): void {
    this.epoch += 1;
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
