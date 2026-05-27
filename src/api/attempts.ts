import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { adminAuth } from '../middleware/adminAuth.js';

const router = Router();

// GET /api/attempts?eventId=<id> — list all attempts for an event
router.get('/', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const { eventId, subscriptionId } = req.query;

  if (!eventId && !subscriptionId) {
    res.status(400).json({ error: 'Provide eventId or subscriptionId query param' });
    return;
  }

  let rows;
  if (eventId) {
    rows = db.prepare(`
      SELECT da.*, s.target_url
      FROM delivery_attempts da
      JOIN subscriptions s ON s.id = da.subscription_id
      WHERE da.event_id = ?
      ORDER BY da.attempt_number ASC
    `).all(eventId);
  } else {
    rows = db.prepare(`
      SELECT da.*, e.event_type
      FROM delivery_attempts da
      JOIN events e ON e.id = da.event_id
      WHERE da.subscription_id = ?
      ORDER BY da.scheduled_at DESC
      LIMIT 100
    `).all(subscriptionId);
  }

  res.json(rows);
});

// POST /api/attempts/:id/retry — manually retry a failed or abandoned attempt
router.post('/:id/retry', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();

  const attempt = db.prepare(`
    SELECT da.*, s.is_active
    FROM delivery_attempts da
    JOIN subscriptions s ON s.id = da.subscription_id
    WHERE da.id = ?
  `).get(req.params.id) as any;

  if (!attempt) {
    res.status(404).json({ error: 'Attempt not found' });
    return;
  }

  // Prevent retry on attempts that are pending/in-progress
  if (['pending', 'attempting'].includes(attempt.status)) {
    res.status(409).json({ error: 'Attempt is already pending or in progress' });
    return;
  }

  // Get the latest attempt number for this event+subscription pair
  const maxRow = db.prepare(`
    SELECT MAX(attempt_number) as max_num
    FROM delivery_attempts
    WHERE event_id = ? AND subscription_id = ?
  `).get(attempt.event_id, attempt.subscription_id) as { max_num: number };

  const nextAttemptNumber = (maxRow?.max_num ?? 0) + 1;
  const newAttemptId = uuidv4();
  const now = Date.now();

  // Manual retries bypass the max_attempts cap — operator made an explicit call
  db.prepare(`
    INSERT INTO delivery_attempts
      (id, event_id, subscription_id, attempt_number, status, scheduled_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(newAttemptId, attempt.event_id, attempt.subscription_id, nextAttemptNumber, now);

  res.status(201).json({
    id: newAttemptId,
    message: `Manual retry queued as attempt #${nextAttemptNumber}`,
    scheduled_at: now,
  });
});

export default router;
