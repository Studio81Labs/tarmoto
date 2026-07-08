/** Thrown when the upstream budget is backed up beyond `maxWaitMs`. Callers
 *  treat it like any other provider failure and degrade gracefully. */
export class GeocoderBusyError extends Error {
  constructor() {
    super('Geocoder upstream request budget is backed up');
    this.name = 'GeocoderBusyError';
  }
}

/**
 * Serializes tasks so each one STARTS at most once per `minSpacingMs`,
 * enforcing a hard upstream request rate (≤ 1/s for public Nominatim per its
 * usage policy — ADR-0002 / #909). Slots are reserved synchronously, so
 * concurrent callers (e.g. the planner reverse-geocoding several waypoints in a
 * single render) queue in arrival order instead of bursting past the cap.
 *
 * Bounded by `maxWaitMs`: a task that would have to wait longer than that is
 * rejected immediately with {@link GeocoderBusyError} rather than queued —
 * capping both added latency and the effective queue depth, so a burst sheds
 * load (graceful fallback) instead of piling up unbounded work.
 *
 * Process-local: enforces the rate per instance. A multi-instance deploy allows
 * N× the rate in aggregate; a self-hosted Nominatim (`TARMOTO_NOMINATIM_URL`)
 * removes the cap entirely and is the cross-instance fix.
 */
export class MinSpacingLimiter {
  private nextSlot = 0;

  constructor(
    private readonly minSpacingMs: number,
    private readonly maxWaitMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    const waitMs = slot - now;
    if (waitMs > this.maxWaitMs) {
      throw new GeocoderBusyError();
    }
    // Reserve synchronously (before any await) so concurrent callers each get a
    // distinct, ordered slot.
    this.nextSlot = slot + this.minSpacingMs;
    if (waitMs > 0) await this.sleep(waitMs);
    return task();
  }
}
