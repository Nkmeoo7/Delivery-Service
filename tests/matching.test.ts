import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../src/services/matching';

describe('matchesFilter', () => {
  it('wildcard * matches everything', () => {
    expect(matchesFilter('order.created', '*')).toBe(true);
    expect(matchesFilter('user.deleted', '*')).toBe(true);
    expect(matchesFilter('anything', '*')).toBe(true);
  });

  it('exact match works', () => {
    expect(matchesFilter('order.created', 'order.created')).toBe(true);
    expect(matchesFilter('order.created', 'order.updated')).toBe(false);
  });

  it('glob pattern order.* matches subtypes', () => {
    expect(matchesFilter('order.created', 'order.*')).toBe(true);
    expect(matchesFilter('order.updated', 'order.*')).toBe(true);
    expect(matchesFilter('order.deleted', 'order.*')).toBe(true);
  });

  it('glob pattern order.* does not match other domains', () => {
    expect(matchesFilter('user.created', 'order.*')).toBe(false);
    expect(matchesFilter('payment.failed', 'order.*')).toBe(false);
  });

  it('nested glob user.*.created', () => {
    expect(matchesFilter('user.profile.created', 'user.*.created')).toBe(true);
    expect(matchesFilter('user.settings.created', 'user.*.created')).toBe(true);
    expect(matchesFilter('user.created', 'user.*.created')).toBe(false);
  });

  it('does not cross domain boundaries with flat glob', () => {
    expect(matchesFilter('order', 'order.*')).toBe(false);
  });
});
