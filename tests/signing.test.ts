import { describe, it, expect } from 'vitest';
import { sign, verify } from '../src/services/signing';

describe('sign', () => {
  it('produces sha256= prefixed signature', () => {
    const sig = sign('mysecret', 1700000000000, '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('is deterministic for same inputs', () => {
    const a = sign('secret', 12345, 'body');
    const b = sign('secret', 12345, 'body');
    expect(a).toBe(b);
  });

  it('changes when secret changes', () => {
    const a = sign('secret1', 12345, 'body');
    const b = sign('secret2', 12345, 'body');
    expect(a).not.toBe(b);
  });

  it('changes when timestamp changes', () => {
    const a = sign('secret', 10000, 'body');
    const b = sign('secret', 20000, 'body');
    expect(a).not.toBe(b);
  });

  it('changes when body changes', () => {
    const a = sign('secret', 12345, 'body1');
    const b = sign('secret', 12345, 'body2');
    expect(a).not.toBe(b);
  });
});

describe('verify', () => {
  it('accepts correct signature', () => {
    const ts = Date.now();
    const body = '{"type":"order.created"}';
    const sig = sign('mysecret', ts, body);
    expect(verify('mysecret', ts, body, sig)).toBe(true);
  });

  it('rejects tampered body', () => {
    const ts = Date.now();
    const sig = sign('mysecret', ts, '{"original":"body"}');
    expect(verify('mysecret', ts, '{"tampered":"body"}', sig)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const ts = Date.now();
    const body = 'payload';
    const sig = sign('correct-secret', ts, body);
    expect(verify('wrong-secret', ts, body, sig)).toBe(false);
  });

  it('rejects tampered timestamp', () => {
    const ts = Date.now();
    const body = 'payload';
    const sig = sign('secret', ts, body);
    expect(verify('secret', ts + 1, body, sig)).toBe(false);
  });

  it('rejects garbage signature gracefully', () => {
    expect(verify('secret', Date.now(), 'body', 'sha256=not-valid-hex')).toBe(false);
  });
});
