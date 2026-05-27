import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBackoffMs } from '../src/worker/deliveryWorker.js';

describe('getBackoffMs', () => {
  it('attempt 1 = 0 (immediate)', () => {
    expect(getBackoffMs(1)).toBe(0);
  });

  it('attempt 2 = ~10s base + jitter', () => {
    // Mock Math.random to return 0 so jitter = 0
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(getBackoffMs(2)).toBe(10_000);
    vi.restoreAllMocks();
  });

  it('attempt 3 = ~20s base', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(getBackoffMs(3)).toBe(20_000);
    vi.restoreAllMocks();
  });

  it('attempt 4 = ~40s base', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(getBackoffMs(4)).toBe(40_000);
    vi.restoreAllMocks();
  });

  it('is capped at 1 hour', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // attempt 20 would be 2^18 * 10s = way over 1h
    expect(getBackoffMs(20)).toBe(3_600_000);
    vi.restoreAllMocks();
  });

  it('jitter stays within 0–5s range', () => {
    for (let i = 0; i < 50; i++) {
      const delay = getBackoffMs(2); // base is 10_000
      expect(delay).toBeGreaterThanOrEqual(10_000);
      expect(delay).toBeLessThan(15_001);
    }
  });
});
