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
  // The dedupe key of the currently-speaking utterance (if any), so callers can
  // cancel a specific lane by key prefix (e.g. `weather:*`) without touching
  // other lanes that share the same priority.
  private speakingKey: string | undefined = undefined;
  /**
   * True between `mod.speak()` returning success (utterance is in the
   * native queue) and the listener firing for that utterance. Gates
   * `pendingDiscards` increments so a preempt during the cold-start
   * init window — where `speaking=true` but no native utterance has
   * been submitted yet — doesn't record a discard for a `tts-cancel`
   * that will never arrive. Without this, the orphaned discard would
   * swallow the next real `tts-finish` and freeze the queue with
   * `speaking=true` blocking all later prompts.
   */
  private speakingNative = false;
  /**
   * Counter of pending `tts-cancel` events we triggered ourselves via
   * `mod.stop()` and want the listener to swallow. The epoch comparison
   * alone isn't enough on the preempt path: between issuing `stop()`
   * and the native side firing the cancel, the new high-priority
   * utterance starts and tags `speakingEpoch` with the bumped epoch.
   * The cancel from the preempted utterance then arrives with
   * `speakingEpoch === epoch` and would spuriously flip `speaking` off
   * mid-new-utterance. The counter lets the listener identify "this
   * cancel belongs to a stopped utterance, drop it" without needing
   * native utterance ids on the bridge.
   */
  private pendingDiscards = 0;

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
    // First-stage filter: any cancel we triggered ourselves (preempt /
    // stop / pause / external-audio handoff) is recorded as a pending
    // discard before the native side fires the event. Consuming one
    // here lets the listener tell "the OLD utterance just got cancelled
    // by us" apart from "the CURRENT utterance finished naturally" —
    // the two become distinguishable even when they share epoch (the
    // preempt path bumps epoch and immediately drains a new phrase
    // that tags speakingEpoch with the bumped value, so a pure
    // epoch-equality check would treat the stale cancel as belonging
    // to the new one).
    if (this.pendingDiscards > 0) {
      this.pendingDiscards -= 1;
      return;
    }
    // Belt-and-suspenders: a cancel that arrived AFTER we cleared the
    // queue but before any new utterance started will already fail the
    // epoch check (no new drain has reset speakingEpoch yet).
    if (this.speakingEpoch !== this.epoch) return;
    this.speaking = false;
    this.speakingNative = false;
    this.speakingPriority = "normal";
    this.speakingKey = undefined;
    void this.drain();
  };

  /**
   * Cancel the in-flight utterance: bump the epoch so any drain that
   * resumed before the native cancel arrived stops with a stale-epoch
   * check, record a pending discard so `handleUtteranceEnded` swallows
   * the cancel that the native side will fire, and ask the engine to
   * stop. Caller decides WHEN to call (always vs only-if-not-high)
   * and is responsible for any queue clearing — the helper only
   * touches the in-flight utterance, not the queue.
   *
   * No-op when nothing is speaking. Centralised so a future change to
   * the preempt protocol (priority semantics, discard counter shape,
   * native stop signature) only has one site to update.
   */
  private preemptInFlight(): void {
    if (!this.speaking) return;
    // Only record a discard when we know a `tts-cancel` will actually
    // arrive — i.e. when an utterance was already submitted to native.
    // During the cold-start init window, `speaking=true` but
    // `speakingNative=false` because `drain()` is still awaiting
    // `getInitStatus()`; the `mod.stop()` call below has nothing to
    // cancel at that point. Incrementing `pendingDiscards` anyway
    // would orphan a count that swallows the NEXT real `tts-finish`,
    // freezing the queue with `speaking=true`.
    if (this.speakingNative) {
      this.pendingDiscards += 1;
    }
    this.speakingNative = false;
    this.epoch += 1;
    this.speaking = false;
    this.speakingPriority = "normal";
    this.speakingKey = undefined;
    const mod = this.ensureNative();
    if (mod) {
      void Promise.resolve(mod.stop()).catch(() => {
        /* ignore */
      });
    }
  }

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

  private buildSpeakOptions(priority: SpeakPriority): unknown {
    // Android per-utterance options — stream + volume. iOS doesn't
    // expose a per-utterance volume on `react-native-tts`; volume is
    // governed by the system audio session and the `setDucking` flag.
    if (Platform.OS === "android") {
      // High-priority safety alerts always play at full volume,
      // overriding the rider's volume slider — `KEY_PARAM_VOLUME: 0`
      // (the Settings "Mute" bucket) would otherwise silence a crash
      // countdown or storm warning at the native engine level even
      // though `speak()` correctly bypassed the volume<=0 suppression.
      const vol = priority === "high" ? 1 : this.volume;
      return {
        androidParams: {
          ...ANDROID_TTS_OPTIONS.androidParams,
          KEY_PARAM_VOLUME: vol,
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
      this.speakingNative = false;
      return;
    }
    if (this.speaking || this.paused) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.speaking = true;
    // Stays false until the utterance is actually queued in native —
    // see `preemptInFlight` for why this matters during cold start.
    this.speakingNative = false;
    this.speakingPriority = next.priority;
    this.speakingKey = next.key;
    const epochAtStart = this.epoch;
    this.speakingEpoch = epochAtStart;
    try {
      await this.waitForReady(mod);
      if (this.epoch !== epochAtStart) return; // stopped while we waited
      // Mark native as having the utterance BEFORE issuing the call.
      // `mod.speak()` dispatches synchronously to the native bridge —
      // the `await` is only on its resolution. Setting the flag after
      // the await would leave a microtask gap where a preempt would
      // see `speakingNative=false`, skip the discard, and then the
      // (legitimate) cancel from `mod.stop()` would land on the new
      // drain's `speakingEpoch` and end the wrong utterance.
      this.speakingNative = true;
      // Don't await for playback — `speak()` resolves with an utterance
      // id immediately on every published version of the library. The
      // `tts-finish` / `tts-cancel` listener above is what drives the
      // next drain.
      await mod.speak(next.phrase, this.buildSpeakOptions(next.priority));
    } catch {
      // The native side rejected the utterance (audio session denied,
      // invalid voice id, etc.) — no finish/cancel event will fire for
      // it, so unblock the queue ourselves and clear the flag.
      if (this.epoch === epochAtStart) {
        this.speaking = false;
        this.speakingNative = false;
        this.speakingPriority = "normal";
        if (this.queue.length > 0) void this.drain();
      }
    }
  }

  /**
   * Enqueue a phrase. If the native module is unavailable the call is
   * a silent no-op.
   *
   * **Suppression rules — normal priority:**
   *   - `muted` (the NavigationScreen voice FAB or
   *     `usePreferencesStore.voiceNavEnabled = false`).
   *   - `paused` (AppState background, or an explicit ride-pause).
   *   - `volume <= 0` (the Settings "Mute" volume bucket — iOS has no
   *     per-utterance volume parameter, so a 0 bucket would otherwise
   *     play at system volume on iPhone).
   *   - `externalAudioActive` (CarPlay / Android Auto is the active
   *     prompt surface).
   *
   * **High-priority phrases (`{ priority: "high" }`) bypass ALL of the
   * above.** Crash countdown and critical weather alerts are
   * safety-critical and must reach the rider regardless of:
   *   - the voice-guidance mute toggle (the FAB silences guidance, not
   *     safety alerts),
   *   - the volume slider (a rider who chose "Mute" still needs to
   *     hear a crash countdown),
   *   - external audio (the head unit doesn't surface crash/weather).
   * They are still gated by `paused`, since `paused` represents the
   * rider explicitly stopping the audio path (e.g. a ride break) and
   * is short-lived enough that an alert will re-fire on resume.
   *
   * **Dedupe rules:** with a `key`, any pending entry sharing the key
   * is replaced (collapses a stale "in 300 m" against a fresh "in 50
   * m" for the same maneuver, or a re-fired weather alert). Without a
   * `key`, an exact repeat of the most-recent queued phrase is
   * suppressed to avoid back-to-back GPS-tick duplicates.
   *
   * **Preempt:** a high-priority phrase stops any in-flight
   * normal-priority utterance and plays immediately. A high-priority
   * phrase already speaking runs to completion — a second
   * high-priority phrase queues behind it. Stable `key`s still dedupe
   * high-priority entries against each other.
   */
  speak(phrase: string, options?: SpeakOptions): void {
    const priority: SpeakPriority = options?.priority ?? "normal";
    const key = options?.key;

    // Normal-priority gates — high-priority phrases bypass these so a
    // crash countdown still fires when the rider has the FAB muted,
    // the volume slider on Mute, or CarPlay connected.
    if (priority !== "high") {
      if (this.muted) return;
      if (this.volume <= 0) return;
      if (this.externalAudioActive) return;
    }
    const mod = this.ensureNative();
    if (!mod) return;

    if (priority === "high") {
      // Drop any normal-priority phrases queued behind us — by the time
      // the high-priority alert finishes the rider has likely moved
      // past the maneuver those prompts were tied to anyway. Pending
      // high-priority phrases stay so a queued crash followup doesn't
      // get silently swallowed by a hazard alert.
      this.queue = this.queue.filter((q) => q.priority === "high");
      // Honour the dedupe key for high-priority phrases too — a weather
      // poll that re-emits the same critical alert (or a re-rendered
      // crash overlay) shouldn't stack identical entries.
      if (key !== undefined) {
        const existing = this.queue.findIndex((q) => q.key === key);
        if (existing >= 0) {
          this.queue[existing] = { phrase, priority, key };
        } else {
          this.queue.push({ phrase, priority, key });
        }
      } else {
        this.queue.push({ phrase, priority, key });
      }
      // Preempt the in-flight utterance only if it's lower priority. A
      // high-priority phrase already speaking should run to completion
      // — a second high-priority phrase queues behind it.
      if (this.speakingPriority !== "high") {
        this.preemptInFlight();
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
    this.queue = [];
    if (this.speaking) {
      this.preemptInFlight();
    } else {
      // No in-flight utterance, but bump the epoch anyway so any
      // currently-awaiting drain (e.g. waiting on getInitStatus) bails
      // with a stale-epoch check before it issues mod.speak().
      this.epoch += 1;
    }
  }

  /**
   * Stop NAVIGATION (normal-priority) prompts only, preserving any in-flight or
   * queued HIGH-priority safety utterance (crash countdown, critical weather).
   *
   * Used when a navigation session tears down — e.g. a `basic_navigation` kill
   * flips the session off, or the screen unmounts — where the broad `stop()`
   * would also cancel the safety lane. A rider whose phone is stowed must not
   * lose an in-progress SOS countdown just because turn-by-turn ended. Mirrors
   * `setMuted`'s selective teardown, but one-shot (doesn't set the mute flag).
   */
  stopNavigation(): void {
    // Drop pending normal-priority phrases; keep queued high-priority alerts.
    this.queue = this.queue.filter((q) => q.priority === "high");
    // Only preempt the in-flight utterance when it's a navigation prompt —
    // never cut off a safety alert mid-word.
    if (this.speaking && this.speakingPriority !== "high") {
      this.preemptInFlight();
      // `preemptInFlight` marks the native cancel for discard, so the
      // `tts-cancel` event won't drive the drain — restart it here or a
      // preserved queued high-priority alert (crash countdown) would sit
      // unspoken indefinitely.
      void this.drain();
    }
  }

  /**
   * Cancel every utterance — queued OR in-flight — whose dedupe key starts with
   * `prefix`, leaving all other lanes untouched. Targeted so an operator kill
   * can silence one feature's speech even when it rides the high-priority lane
   * that navigation teardown intentionally preserves: `weather_alerts`
   * force_off cancels `weather:*` while an in-flight `crash:countdown` (also
   * high priority) keeps playing.
   */
  cancelByKeyPrefix(prefix: string): void {
    this.queue = this.queue.filter((q) => !q.key?.startsWith(prefix));
    if (this.speaking && this.speakingKey?.startsWith(prefix)) {
      this.preemptInFlight();
      // `preemptInFlight` marks the native cancel for discard, so the
      // `tts-cancel` event won't drive the drain — restart it here or a phrase
      // queued behind the cancelled one (e.g. a crash countdown queued behind a
      // weather warning) would sit unspoken indefinitely.
      void this.drain();
    }
  }

  /**
   * Toggle the voice-guidance mute. Affects normal-priority phrases
   * only — high-priority safety alerts (crash countdown, critical
   * weather) bypass the mute flag at speak() time so the rider can't
   * accidentally silence the safety channel by tapping the voice FAB.
   * Muting drops any pending NORMAL-priority phrases so a rider who
   * mutes mid-route doesn't hear stale prompts on un-mute, but
   * preserves any queued high-priority alerts.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) return;
    // Drop only normal-priority queue entries; keep high-priority
    // alerts so a queued crash/weather notice still fires.
    this.queue = this.queue.filter((q) => q.priority === "high");
    if (this.speakingPriority !== "high") {
      this.preemptInFlight();
    }
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
    // Drop the in-flight utterance so we don't hear the tail of a
    // half-spoken prompt when audio resumes — a fresh prompt will
    // fire on the next maneuver instead. The preempt helper records
    // the cancel as ours so it doesn't trigger a spurious drain on
    // resume.
    this.preemptInFlight();
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
      if (this.speakingPriority !== "high") {
        this.preemptInFlight();
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
   *
   * Setting volume to 0 (the Settings "Mute" bucket) acts like
   * `setMuted(true)` for the queue: any pending normal-priority
   * phrases are dropped and the in-flight utterance (if normal
   * priority) is preempted. Without this, queued phrases would still
   * drain — silently on Android via `KEY_PARAM_VOLUME: 0` but
   * **audibly** on iOS, which has no per-utterance volume in
   * `react-native-tts`. High-priority safety alerts are preserved on
   * the queue and bypass the volume<=0 gate at speak() time.
   */
  setVolume(volume: number): void {
    const next = clampVolume(volume);
    const wasAudible = this.volume > 0;
    this.volume = next;
    if (next > 0 || !wasAudible) return;
    this.queue = this.queue.filter((q) => q.priority === "high");
    if (this.speakingPriority !== "high") {
      this.preemptInFlight();
    }
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
    this.speakingNative = false;
    this.speakingPriority = "normal";
    this.pendingDiscards = 0;
    this.muted = false;
    this.paused = false;
    this.externalAudioActive = false;
    this.volume = 1;
  }
}

export const ttsService = new TtsService();
