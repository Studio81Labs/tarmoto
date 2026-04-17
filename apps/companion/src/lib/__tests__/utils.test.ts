/**
 * Pure formatting and classification helpers from lib/utils.ts.
 *
 * These are the first companion tests and establish the pattern:
 * - Unit tests for pure functions live next to source under __tests__/
 * - Vitest globals (describe/it/expect) available without imports
 */

import {
  scoreToTier,
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  formatRelativeTime,
  confidenceLabel,
} from '../utils';

describe('scoreToTier', () => {
  it.each([
    [5.0, 'excellent'],
    [4.5, 'excellent'],
    [4.0, 'good'],
    [3.5, 'good'],
    [3.0, 'fair'],
    [2.5, 'fair'],
    [2.0, 'poor'],
    [1.5, 'poor'],
    [1.0, 'very-poor'],
    [0.0, 'very-poor'],
  ])('maps score %s to tier "%s"', (score, expected) => {
    expect(scoreToTier(score)).toBe(expected);
  });
});

describe('formatDistance', () => {
  it('rounds km to whole numbers', () => {
    expect(formatDistance(1)).toMatch(/1/);
    expect(formatDistance(12.6)).toMatch(/13/);
  });
});

describe('formatDuration', () => {
  it('uses minutes-only format under an hour', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(0)).toBe('0 min');
  });

  it('uses hours and minutes over an hour', () => {
    expect(formatDuration(60)).toBe('1h 0m');
    expect(formatDuration(90)).toBe('1h 30m');
    expect(formatDuration(125)).toBe('2h 5m');
  });
});

describe('formatElevation', () => {
  it('rounds meters to whole numbers with unit', () => {
    expect(formatElevation(123.4)).toBe('123 m');
    expect(formatElevation(0)).toBe('0 m');
  });
});

describe('formatSpeed', () => {
  it('rounds km/h to whole numbers with unit', () => {
    expect(formatSpeed(42.7)).toBe('43 km/h');
    expect(formatSpeed(0)).toBe('0 km/h');
  });
});

describe('formatRelativeTime', () => {
  const REFERENCE_NOW = new Date('2026-04-17T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(REFERENCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for <1 minute ago', () => {
    const iso = new Date(REFERENCE_NOW - 30_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('just now');
  });

  it('returns minutes for <1 hour ago', () => {
    const iso = new Date(REFERENCE_NOW - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('5m ago');
  });

  it('returns hours for <24 hours ago', () => {
    const iso = new Date(REFERENCE_NOW - 3 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('3h ago');
  });

  it('returns days for <7 days ago', () => {
    const iso = new Date(REFERENCE_NOW - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('2d ago');
  });

  it('falls back to an absolute date for >=7 days ago', () => {
    const iso = new Date(REFERENCE_NOW - 10 * 24 * 60 * 60_000).toISOString();
    const out = formatRelativeTime(iso);
    expect(out).not.toMatch(/ago$/);
    expect(out).toMatch(/20\d{2}/);
  });
});

describe('confidenceLabel', () => {
  it.each([
    [0.9, 'High'],
    [0.8, 'High'],
    [0.7, 'Medium'],
    [0.5, 'Medium'],
    [0.4, 'Low'],
    [0.0, 'Low'],
  ])('maps confidence %s to "%s"', (confidence, expected) => {
    expect(confidenceLabel(confidence)).toBe(expected);
  });
});
