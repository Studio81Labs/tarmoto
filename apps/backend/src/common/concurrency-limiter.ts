/**
 * Small dependency-free FIFO concurrency limiter.
 *
 * The planner uses it around expensive shared resources (routing engines and
 * PostGIS enrichment). A request can enqueue many independent days/legs, but
 * only `maxConcurrency` tasks are allowed to consume the resource at once.
 * Queued work observes AbortSignal so a disconnected request does not linger.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error('maxConcurrency must be a positive integer');
    }
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const start = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        const reason: unknown = signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new DOMException('Aborted', 'AbortError'),
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(start);
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const next = this.queue.shift();
      if (!next) return;
      next();
    }
  }
}

/** Parse a positive integer env/config value with a bounded safe fallback. */
export function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}
