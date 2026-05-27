import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app, server } from '../src/index.js';
import { resetDb } from '../src/db/database.js';

// DB_PATH=:memory: is set in vitest.config.ts so each fork gets a fresh in-memory DB
const ADMIN_KEY = 'change-me-in-production';
const headers = { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' };

beforeEach(() => {
  // Reset the DB singleton so each test starts with empty tables
  resetDb();
});

afterAll(() => {
  server.close();
  resetDb();
});

describe('POST /api/subscriptions', () => {
  it('creates a subscription with valid data', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'https://example.com/hook', event_filter: 'order.*' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      target_url: 'https://example.com/hook',
      event_filter: 'order.*',
      is_active: 1,
    });
    expect(res.body.id).toBeTruthy();
  });

  it('rejects missing target_url', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ event_filter: 'order.*' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid URL', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('requires admin key', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://example.com' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/events + fan-out', () => {
  it('ingests event and creates attempt for matching subscription', async () => {
    await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'https://example.com/hook', event_filter: 'order.*' });

    const res = await request(app)
      .post('/api/events')
      .set(headers)
      .send({ type: 'order.created', data: { orderId: '123' } });

    expect(res.status).toBe(202);
    expect(res.body.matched_subscriptions).toBe(1);
    expect(res.body.id).toBeTruthy();
  });

  it('does not match subscription with different filter', async () => {
    await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'https://example.com/hook', event_filter: 'user.*' });

    const res = await request(app)
      .post('/api/events')
      .set(headers)
      .send({ type: 'order.created', data: {} });

    expect(res.status).toBe(202);
    expect(res.body.matched_subscriptions).toBe(0);
  });

  it('wildcard subscription matches all events', async () => {
    await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'https://example.com/hook', event_filter: '*' });

    const res = await request(app)
      .post('/api/events')
      .set(headers)
      .send({ type: 'payment.failed', data: {} });

    expect(res.status).toBe(202);
    expect(res.body.matched_subscriptions).toBe(1);
  });
});

describe('DELETE /api/subscriptions/:id', () => {
  it('deactivates a subscription and stops fan-out', async () => {
    const create = await request(app)
      .post('/api/subscriptions')
      .set(headers)
      .send({ target_url: 'https://example.com/hook', event_filter: '*' });

    const del = await request(app)
      .delete(`/api/subscriptions/${create.body.id}`)
      .set(headers);

    expect(del.status).toBe(200);

    const event = await request(app)
      .post('/api/events')
      .set(headers)
      .send({ type: 'order.created', data: {} });

    expect(event.body.matched_subscriptions).toBe(0);
  });
});

describe('POST /api/attempts/:id/retry', () => {
  it('rejects retry on non-existent attempt', async () => {
    const res = await request(app)
      .post('/api/attempts/nonexistent-id/retry')
      .set(headers);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/events', () => {
  it('returns empty list when no events', async () => {
    const res = await request(app).get('/api/events').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns ingested events', async () => {
    await request(app)
      .post('/api/events')
      .set(headers)
      .send({ type: 'test.event', data: { x: 1 } });

    const res = await request(app).get('/api/events').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].event_type).toBe('test.event');
  });
});
