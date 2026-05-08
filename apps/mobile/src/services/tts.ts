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
 *   - Supports "high" priority phrases that preempt the queue — the
 *     hazard/crash/weather announcements (US-12, US-13, US-14) take
 *     precedence over turn-by-turn navigation prompts so a rider doesn't
 *     hear "in 300 meters, turn left" while a crash countdown or storm
 *     alert is firing.
 *
 *   - Supports per-phrase dedupe keys so a stale "warning-far" enqueued
 *     before a "warning-near" can be collapsed instead of speaking both
 *     in sequence (the rider has already moved past the far window).
 *
 *   - Routes through CarPlay/Android Auto when active: when an external
 *     vehicle audio surface is presenting prompts (#498), the local TTS
 *     becomes a no-op so the rider doesn't hear every prompt twice.
 *
 * Bluetooth output (AC #1 — "Clear voice prompts via Bluetooth headset")
 * now opts into the most headset-friendly policy the library exposes:
 * iOS ignores the silent switch for navigation prompts, while Android
 * speaks on the voice-call stream so helmet headsets that prefer HFP/SCO
 * routing don't leave the prompt on the handset speaker.
 */

import { Platform } from "react-native";

type TtsEvent = "tts-finish" | "tts-cancel" | "tts-start";

type TtsModule = {
  speak: (text: string, options?: unknown) => Promise<unknown>;
  stop: () => Promise<unknown> | void;
  getInitStatus?: () => Promise<unknown>;
  addEventListener?: (event: TtsEvent, listener: () => void) => unknown;
  removeAllListeners?: (event: TtsEvent) => void;
  setDefaultRate?: (rate: number, skipTransform?: boolean) => Promise<unknown>;
  setDefaultPitch?: (pitch: number) => Promise<unknown>;
  setDefaultLanguage?: (locale: string) => Promise<unknown>;
  setDucking?: (enabled: boolean) => Promise<unknown>;
  setIgnoreSilentSwitch?: (
    mode: "inherit" | "ignore" | "obey",
  ) => Promise<unknown>;
};

const ANDROID_TTS_OPTIONS = {
  androidParams: {
    KEY_PARAM_STREAM: "STREAM_VOICE_CALL",
  },
} as const;

export type SpeakPriority = "normal" | "high";

export interface SpeakOptions {
  /**
   * High-priority phrases preempt the queue: the currently-speaking
   * phrase is stopped, any pending normal-priority phrases are dropped,
   * and the high-priority phrase speaks immediately. Used by hazard,
   * crash, and weather alerts so they're never buried behind a turn cue.
   */
  priority?: SpeakPriority;
  /**
   * Stable identifier for collapsing stale enqueues. When `key` is set,
   * any pending phrase already in the queue with the same key is
   * replaced rather than appended — so a "warning-far" prompt for the
   * same maneuver enqueued twice in quick succession (or replaced by a
   * later "warning-near") never fires both in sequence. Phrases without
   * a key are deduped only against the most-recent queued entry.
   */
  key?: string;
}

interface QueueEntry {
  phrase: string;
  priority: SpeakPriority;
  key: string | undefined;
}

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

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

class TtsService {
  private native: TtsModule | null = null;
  private queue: QueueEntry[] = [];
  private speaking = false;
  private muted = false;
  private paused = false;
  /**
   * When CarPlay / Android Auto is active and rendering the navigation
   * prompts itself, the local handset TTS becomes a no-op. The state
   * machine on the screen still fires announcements; we just don't
   * route them through the device speaker so the rider doesn't hear
   * every cue twice.
   */
  private externalAudioActive = false;
  private configured = false;
  private ready: Promise<void> | null = null;
  private volume = 1;
  // Incremented by `stop()`. Any completion listener belonging to a prior
  // epoch is ignored, so a late `tts-cancel` event from a stopped run
  // can't flip `speaking` off while a fresh utterance is playing. The
  // currently-speaking utterance tags itself with `speakingEpoch`; the
  // finish/cancel handler ignores any event whose epoch no longer matches.
  private epoch = 0;
  private speakingEpoch = 0;
  private speakingPriority: SpeakPriority = "normal";

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
    // Keep nav prompts audible even when the handset mute switch is set.
    // This lets the paired headset still receive turn cues on iOS.
    void mod.setIgnoreSilentSwitch?.("ignore");
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

  private buildSpeakOptions(): unknown {
    // Android per-utterance options — stream + volume. iOS doesn't
    // expose a per-utterance volume on `react-native-tts`; volume is
    // governed by the system audio session and the `setDucking` flag.
    if (Platform.OS === "android") {
      return {
        androidParams: {
          ...ANDROID_TTS_OPTIONS.androidParams,
          KEY_PARAM_VOLUME: this.volume,
        },
      };
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    const mod = this.ensureNative();
    if (!mod) {
      this.queue = [];
      this.speaking = false;
      return;
    }
    if (this.speaking || this.paused) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.speaking = true;
    this.speakingPriority = next.priority;
    const epochAtStart = this.epoch;
    this.speakingEpoch = epochAtStart;
    try {
      await this.waitForReady(mod);
      if (this.epoch !== epochAtStart) return; // stopped while we waited
      // Don't await for playback — `speak()` resolves with an utterance
      // id immediately on every published version of the library. The
      // `tts-finish` / `tts-cancel` listener above is what drives the
      // next drain.
      await mod.speak(next.phrase, this.buildSpeakOptions());
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
   * Enqueue a phrase. If the service is muted, paused, or the native
   * module is unavailable, the call is a silent no-op. When CarPlay
   * (or Android Auto) is the active output for navigation prompts, the
   * call is also a no-op — the head unit speaks the same cue.
   *
   * Dedupe rules:
   *   - With a `key`, any pending entry sharing that key is replaced
   *     with the new phrase (collapses a stale "in 300 m" against a
   *     fresh "in 50 m" for the same maneuver).
   *   - Without a `key`, we still suppress an immediate exact repeat of
   *     the most-recent queued phrase to avoid back-to-back GPS-tick
   *     duplicates.
   *
   * High-priority phrases bypass the queue: the in-flight utterance
   * (if any normal-priority) is stopped and the new phrase plays
   * immediately. A high-priority phrase already speaking is never
   * preempted by another high-priority phrase — they queue behind it
   * so a hazard alert isn't cut off by a second hazard alert.
   */
  speak(phrase: string, options?: SpeakOptions): void {
    if (this.muted) return;
    if (this.externalAudioActive) return;
    const mod = this.ensureNative();
    if (!mod) return;

    const priority: SpeakPriority = options?.priority ?? "normal";
    const key = options?.key;

    if (priority === "high") {
      // Drop any normal-priority phrases queued behind us — by the time
      // the high-priority alert finishes the rider has likely moved
      // past the maneuver those prompts were tied to anyway. Pending
      // high-priority phrases stay so a queued crash followup doesn't
      // get silently swallowed by a hazard alert.
      this.queue = this.queue.filter((q) => q.priority === "high");
      this.queue.push({ phrase, priority, key });
      // Preempt the in-flight utterance only if it's lower priority. A
      // high-priority phrase already speaking should run to completion
      // — a second high-priority phrase queues behind it.
      if (this.speaking && this.speakingPriority !== "high") {
        this.epoch += 1;
        this.speaking = false;
        void Promise.resolve(mod.stop()).catch(() => {
          /* ignore */
        });
      }
      void this.drain();
      return;
    }

    if (key !== undefined) {
      const existingIndex = this.queue.findIndex((q) => q.key === key);
      if (existingIndex >= 0) {
        this.queue[existingIndex] = { phrase, priority, key };
        // Don't kick the drain — there's already a pending entry at
        // that slot which will be picked up in turn.
        if (!this.speaking) void this.drain();
        return;
      }
    } else {
      const last = this.queue[this.queue.length - 1];
      if (last && last.phrase === phrase) return;
    }

    this.queue.push({ phrase, priority, key });
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
    this.speakingPriority = "normal";
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

  /**
   * Pause playback without tearing down the session — phrases queued
   * while paused stay queued and resume on `resume()`. Used by the
   * ride-pause flow so a rider taking a breather isn't left hearing a
   * stale "in 300 meters" five minutes after they stopped, and by
   * AppState transitions so a backgrounded screen doesn't keep the
   * audio path warm.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.speaking) {
      // Drop the in-flight utterance so we don't hear the tail of a
      // half-spoken prompt when audio resumes — a fresh prompt will
      // fire on the next maneuver instead.
      this.epoch += 1;
      this.speaking = false;
      this.speakingPriority = "normal";
      const mod = this.ensureNative();
      if (mod) {
        void Promise.resolve(mod.stop()).catch(() => {
          /* ignore */
        });
      }
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.drain();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Mark CarPlay / Android Auto as the active prompt surface. While
   * active, `speak()` becomes a no-op so the rider doesn't hear every
   * cue twice (once on the head unit, once on the handset). Flipping
   * back to false re-enables local playback for the next phrase.
   */
  setExternalAudioActive(active: boolean): void {
    this.externalAudioActive = active;
    if (active) {
      // Don't carry pending normal-priority prompts across the handoff
      // — by the time the rider unplugs we'd be replaying stale cues
      // for maneuvers they've already passed.
      this.queue = this.queue.filter((q) => q.priority === "high");
      if (this.speaking && this.speakingPriority !== "high") {
        this.epoch += 1;
        this.speaking = false;
        const mod = this.ensureNative();
        if (mod) {
          void Promise.resolve(mod.stop()).catch(() => {
            /* ignore */
          });
        }
      }
    }
  }

  isExternalAudioActive(): boolean {
    return this.externalAudioActive;
  }

  /**
   * Set the spoken language for subsequent phrases. Locale follows the
   * BCP-47 conventions react-native-tts inherits from the platform
   * (e.g. "en-US", "cs-CZ", "sk-SK", "de-DE"). Failures (locale not
   * installed, engine missing) are swallowed so the queue keeps
   * draining — speaking in the engine's default voice is better than
   * dropping the prompt entirely.
   */
  setLanguage(locale: string): void {
    const mod = this.ensureNative();
    if (!mod || typeof mod.setDefaultLanguage !== "function") return;
    void Promise.resolve(mod.setDefaultLanguage(locale)).catch(() => {
      /* ignore — voice prompt will use the engine default */
    });
  }

  /**
   * Per-utterance volume hint, 0..1. Applied to Android via
   * `KEY_PARAM_VOLUME`; iOS uses the system audio session volume so
   * this is stored but no-ops on iOS playback. Out-of-range values are
   * clamped silently — the setting screen handles its own validation.
   */
  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
  }

  getVolume(): number {
    return this.volume;
  }

  /** True when a real native TTS binding is available. Used by tests. */
  hasNative(): boolean {
    return this.ensureNative() !== null;
  }

  /** Test seam — drop runtime state so each test starts clean. */
  __resetForTest(): void {
    this.epoch += 1;
    this.queue = [];
    this.speaking = false;
    this.speakingPriority = "normal";
    this.muted = false;
    this.paused = false;
    this.externalAudioActive = false;
    this.volume = 1;
  }
}

export const ttsService = new TtsService();
