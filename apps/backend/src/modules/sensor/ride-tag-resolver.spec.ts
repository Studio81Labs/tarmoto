import {
  resolveTagForTimestamp,
  POINT_TAG_HALF_WINDOW_MS,
  type RideTagEvent,
} from '@tarmoto/shared';

describe('resolveTagForTimestamp (research issue #7)', () => {
  it('returns null when no tag has fired yet', () => {
    const events: RideTagEvent[] = [{ t: 1_000, label: 'smooth_asphalt' }];
    expect(resolveTagForTimestamp(events, 500)).toBeNull();
  });

  it('returns the most recent span tag for windows after it', () => {
    const events: RideTagEvent[] = [
      { t: 1_000, label: 'smooth_asphalt' },
      { t: 2_000, label: 'cobblestone' },
    ];
    expect(resolveTagForTimestamp(events, 1_500)?.label).toBe('smooth_asphalt');
    expect(resolveTagForTimestamp(events, 2_500)?.label).toBe('cobblestone');
  });

  it('treats span tags as sustained until the next tag', () => {
    const events: RideTagEvent[] = [
      { t: 0, label: 'gravel' },
      { t: 60_000, label: 'dirt' },
    ];
    // 30s after `gravel` — still gravel.
    expect(resolveTagForTimestamp(events, 30_000)?.label).toBe('gravel');
    // 1s before `dirt` — still gravel (span hasn't ended).
    expect(resolveTagForTimestamp(events, 59_000)?.label).toBe('gravel');
    // After dirt — dirt.
    expect(resolveTagForTimestamp(events, 70_000)?.label).toBe('dirt');
  });

  it('lets a pothole point tag override the surrounding span', () => {
    const events: RideTagEvent[] = [
      { t: 0, label: 'smooth_asphalt' },
      { t: 5_000, label: 'pothole' },
    ];
    // Inside the point tag's ±half-window — pothole wins.
    expect(
      resolveTagForTimestamp(events, 5_000 + POINT_TAG_HALF_WINDOW_MS - 1)
        ?.label,
    ).toBe('pothole');
    // Outside the point tag's window — span resumes.
    expect(
      resolveTagForTimestamp(events, 5_000 + POINT_TAG_HALF_WINDOW_MS + 1)
        ?.label,
    ).toBe('smooth_asphalt');
  });

  it('does not let a point tag leak forward past its window', () => {
    const events: RideTagEvent[] = [{ t: 0, label: 'pothole' }];
    // Right at the edge of the half-window — still hit.
    expect(
      resolveTagForTimestamp(events, POINT_TAG_HALF_WINDOW_MS)?.label,
    ).toBe('pothole');
    // Just past it — back to null (no span context).
    expect(
      resolveTagForTimestamp(events, POINT_TAG_HALF_WINDOW_MS + 1),
    ).toBeNull();
  });

  it('handles an empty event list', () => {
    expect(resolveTagForTimestamp([], 1_234_567)).toBeNull();
  });

  it('is idempotent against duplicate span tags at the same timestamp', () => {
    // Offline-queue retry could replay the same upload — the resolver
    // must not change behaviour when the same tag appears twice.
    const events: RideTagEvent[] = [
      { t: 1_000, label: 'cobblestone' },
      { t: 1_000, label: 'cobblestone' },
    ];
    expect(resolveTagForTimestamp(events, 2_000)?.label).toBe('cobblestone');
  });
});
