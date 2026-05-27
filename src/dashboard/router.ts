import { Router, Request, Response } from 'express';
import { getDb } from '../db/database.js';

const router = Router();

// GET /dashboard — subscriptions overview
router.get('/', (_req: Request, res: Response): void => {
  const db = getDb();
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

  res.render('subscriptions', { subscriptions, page: 'subscriptions' });
});

// GET /dashboard/events — recent events
router.get('/events', (req: Request, res: Response): void => {
  const db = getDb();
  const limit = 50;
  const offset = parseInt(String(req.query.offset || '0'), 10);
  const typeFilter = req.query.type ? String(req.query.type) : null;

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
  res.render('events', { events, page: 'events', offset, hasMore, typeFilter });
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

  res.render('subscription-detail', { sub, attempts, page: 'subscriptions' });
});

export default router;
