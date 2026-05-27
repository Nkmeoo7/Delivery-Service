import { describe, it, expect } from 'vitest';
import { matchPattern } from '../src/services/matching.js';

describe('matchPattern', () => {
  it('wildcard * matches everything', () => {
    expect(matchPattern('order.created', '*')).toBe(true);
    expect(matchPattern('user.deleted', '*')).toBe(true);
    expect(matchPattern('anything', '*')).toBe(true);
  });

  it('exact match works', () => {
    expect(matchPattern('order.created', 'order.created')).toBe(true);
    expect(matchPattern('order.created', 'order.updated')).toBe(false);
  });

  it('glob pattern order.* matches subtypes', () => {
    expect(matchPattern('order.created', 'order.*')).toBe(true);
    expect(matchPattern('order.updated', 'order.*')).toBe(true);
    expect(matchPattern('order.deleted', 'order.*')).toBe(true);
  });

  it('glob pattern order.* does not match other domains', () => {
    expect(matchPattern('user.created', 'order.*')).toBe(false);
    expect(matchPattern('payment.failed', 'order.*')).toBe(false);
  });

  it('nested glob user.*.created', () => {
    expect(matchPattern('user.profile.created', 'user.*.created')).toBe(true);
    expect(matchPattern('user.settings.created', 'user.*.created')).toBe(true);
    expect(matchPattern('user.created', 'user.*.created')).toBe(false);
  });

  it('does not cross domain boundaries with flat glob', () => {
    expect(matchPattern('order', 'order.*')).toBe(false);
  });
});
