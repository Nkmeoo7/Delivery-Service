import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { matchPattern } from '../services/matching.js';
import { triggerDelivery } from '../worker/deliveryWorker.js';

const router = express.Router();

// GET /dashboard — subscriptions overview
router.get('/', (req: Request, res: Response): void => {
  const db = getDb();
  const error = req.query.error ? String(req.query.error) : null;
  const success = req.query.success ? String(req.query.success) : null;

  const subscriptions = db.prepare(`
    SELECT
      s.*,
      COUNT(da.id) as total_attempts,
      SUM(CASE WHEN da.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
      SUM(CASE WHEN da.status = 'abandoned' THEN 1 ELSE 0 END) as abandoned_count,
      SUM(CASE WHEN da.status IN ('pending','attempting','failed') THEN 1 ELSE 0 END) as pending_count
    FROM subscriptions s
    LEFT JOIN delivery_attempts da ON da.subscription_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();

  res.render('subscriptions', { subscriptions, page: 'subscriptions', error, success });
});

// GET /dashboard/events — recent events
router.get('/events', (req: Request, res: Response): void => {
  const db = getDb();
  const limit = 50;
  const offset = parseInt(String(req.query.offset || '0'), 10);
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const error = req.query.error ? String(req.query.error) : null;
  const success = req.query.success ? String(req.query.success) : null;

  const events = db.prepare(`
    SELECT
      e.*,
      COUNT(da.id) as total_attempts,
      SUM(CASE WHEN da.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
      SUM(CASE WHEN da.status = 'abandoned' THEN 1 ELSE 0 END) as abandoned_count,
      SUM(CASE WHEN da.status IN ('pending','attempting','failed') THEN 1 ELSE 0 END) as pending_count
    FROM events e
    LEFT JOIN delivery_attempts da ON da.event_id = e.id
    ${typeFilter ? "WHERE e.event_type LIKE ?" : ""}
    GROUP BY e.id
    ORDER BY e.ingested_at DESC
    LIMIT ? OFFSET ?
  `).all(...(typeFilter ? [`%${typeFilter}%`] : []), limit, offset);

  const hasMore = events.length === limit;
  res.render('events', { events, page: 'events', offset, hasMore, typeFilter, error, success });
});

// GET /dashboard/events/:id — event detail + delivery attempts
router.get('/events/:id', (req: Request, res: Response): void => {
  const db = getDb();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id) as any;
  if (!event) { res.status(404).send('Event not found'); return; }

  const attempts = db.prepare(`
    SELECT da.*, s.target_url, s.event_filter
    FROM delivery_attempts da
    JOIN subscriptions s ON s.id = da.subscription_id
    WHERE da.event_id = ?
    ORDER BY da.subscription_id, da.attempt_number ASC
  `).all(req.params.id);

  res.render('event-detail', { event, attempts, page: 'events' });
});

// GET /dashboard/subscriptions/:id — subscription detail
router.get('/subscriptions/:id', (req: Request, res: Response): void => {
  const db = getDb();
  const error = req.query.error ? String(req.query.error) : null;
  const success = req.query.success ? String(req.query.success) : null;

  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id) as any;
  if (!sub) { res.status(404).send('Subscription not found'); return; }

  const attempts = db.prepare(`
    SELECT da.*, e.event_type, e.ingested_at
    FROM delivery_attempts da
    JOIN events e ON e.id = da.event_id
    WHERE da.subscription_id = ?
    ORDER BY da.scheduled_at DESC
    LIMIT 100
  `).all(req.params.id);

  res.render('subscription-detail', { sub, attempts, page: 'subscriptions', error, success });
});

// POST /dashboard/subscriptions — register subscription via form
router.post('/subscriptions', (req: Request, res: Response): void => {
  const db = getDb();
  try {
    const target_url = String(req.body.target_url || '').trim();
    const secret = req.body.secret ? String(req.body.secret).trim() : null;
    const event_filter = req.body.event_filter ? String(req.body.event_filter).trim() : '*';

    if (!target_url) {
      throw new Error('Target URL is required');
    }
    // Basic validation
    new URL(target_url);

    const id = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO subscriptions (id, target_url, secret, event_filter, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, target_url, secret || null, event_filter, now);

    res.redirect(`/dashboard?success=${encodeURIComponent('Subscription registered successfully!')}`);
  } catch (err: any) {
    res.redirect(`/dashboard?error=${encodeURIComponent(err.message || 'Failed to create subscription')}`);
  }
});

// POST /dashboard/events — trigger/ingest event via form
router.post('/events', async (req: Request, res: Response): Promise<void> => {
  const db = getDb();
  try {
    const type = String(req.body.type || '').trim();
    const dataRaw = String(req.body.data || '').trim();

    if (!type) {
      throw new Error('Event type is required');
    }

    let parsedData = {};
    if (dataRaw) {
      try {
        parsedData = JSON.parse(dataRaw);
      } catch {
        throw new Error('Invalid JSON format in payload');
      }
    }

    const eventId = uuidv4();
    const now = Date.now();
    const envelope = JSON.stringify({ id: eventId, type, timestamp: now, data: parsedData });

    const matchedCount = db.transaction(() => {
      db.prepare(`
        INSERT INTO events (id, event_type, payload, ingested_at)
        VALUES (?, ?, ?, ?)
      `).run(eventId, type, envelope, now);

      const subs = db.prepare(
        'SELECT id, event_filter FROM subscriptions WHERE is_active = 1'
      ).all() as { id: string; event_filter: string }[];

      const matched = subs.filter(s => matchPattern(type, s.event_filter));

      for (const sub of matched) {
        db.prepare(`
          INSERT INTO delivery_attempts
            (id, event_id, subscription_id, attempt_number, status, scheduled_at)
          VALUES (?, ?, ?, 1, 'pending', ?)
        `).run(uuidv4(), eventId, sub.id, now);
      }
      return matched.length;
    })();

    if (process.env.VERCEL && matchedCount > 0) {
      try {
        await triggerDelivery();
      } catch (err) {
        console.error('[serverless] Trigger delivery failed:', err);
      }
    }

    res.redirect(`/dashboard/events?success=${encodeURIComponent('Event ingested and fan-out queued!')}`);
  } catch (err: any) {
    res.redirect(`/dashboard/events?error=${encodeURIComponent(err.message || 'Failed to trigger event')}`);
  }
});

// POST /dashboard/subscriptions/:id/deactivate — deactivate subscription via button
router.post('/subscriptions/:id/deactivate', (req: Request, res: Response): void => {
  const db = getDb();
  try {
    const result = db.prepare(
      'UPDATE subscriptions SET is_active = 0 WHERE id = ? AND is_active = 1'
    ).run(req.params.id);

    if (result.changes === 0) {
      throw new Error('Subscription not found or already inactive');
    }
    res.redirect(`/dashboard/subscriptions/${req.params.id}?success=${encodeURIComponent('Subscription deactivated successfully!')}`);
  } catch (err: any) {
    res.redirect(`/dashboard/subscriptions/${req.params.id}?error=${encodeURIComponent(err.message || 'Failed to deactivate')}`);
  }
});

export default router;
