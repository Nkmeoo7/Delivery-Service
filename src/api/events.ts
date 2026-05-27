import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { matchPattern } from '../services/matching.js';

const router = express.Router();

const IngestEventSchema = z.object({
  type: z.string().min(1, 'Event type is required'),
  data: z.record(z.unknown()).default({}),
});

// POST /api/events — ingest an event and atomically fan-out to matching subscriptions
router.post('/', adminAuth, (req: Request, res: Response): void => {
  const parsed = IngestEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { type, data } = parsed.data;
  const db = getDb();
  const eventId = uuidv4();
  const now = Date.now();

  // Build the delivery envelope — this is exactly what subscribers will receive
  const envelope = JSON.stringify({ id: eventId, type, timestamp: now, data });

  // ATOMIC: event row + all attempt rows in a single transaction.
  // If we crash after returning 202, the attempts are already durable.
  const fanOut = db.transaction(() => {
    db.prepare(`
      INSERT INTO events (id, event_type, payload, ingested_at)
      VALUES (?, ?, ?, ?)
    `).run(eventId, type, envelope, now);

    // Load all active subscriptions and match in-process (simpler than SQL glob)
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

    return { eventId, matchCount: matched.length };
  });

  const { matchCount } = fanOut();

  res.status(202).json({
    id: eventId,
    type,
    matched_subscriptions: matchCount,
    message: `Event accepted. Delivery queued for ${matchCount} subscription(s).`,
  });
});

// GET /api/events — list recent events with delivery summary
router.get('/', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200);
  const offset = parseInt(String(req.query.offset || '0'), 10);

  const events = db.prepare(`
    SELECT
      e.*,
      COUNT(da.id) as total_attempts,
      SUM(CASE WHEN da.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
      SUM(CASE WHEN da.status = 'abandoned' THEN 1 ELSE 0 END) as abandoned_count,
      SUM(CASE WHEN da.status IN ('pending','attempting','failed') THEN 1 ELSE 0 END) as pending_count
    FROM events e
    LEFT JOIN delivery_attempts da ON da.event_id = e.id
    GROUP BY e.id
    ORDER BY e.ingested_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json(events);
});

// GET /api/events/:id — single event detail
router.get('/:id', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }
  res.json(event);
});

export default router;
