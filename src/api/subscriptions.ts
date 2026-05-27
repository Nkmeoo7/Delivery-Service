import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db/database.ts';
import { adminAuth } from '../middleware/adminAuth.ts';

const router = Router();

const CreateSubscriptionSchema = z.object({
  target_url: z.string().url('target_url must be a valid URL'),
  secret: z.string().min(1).optional(),
  event_filter: z.string().min(1).default('*'),
});

// POST /api/subscriptions — register a new subscription
router.post('/', adminAuth, (req: Request, res: Response): void => {
  const parsed = CreateSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { target_url, secret, event_filter } = parsed.data;
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();

  db.prepare(`
    INSERT INTO subscriptions (id, target_url, secret, event_filter, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, target_url, secret ?? null, event_filter, now);

  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  res.status(201).json(row);
});

// GET /api/subscriptions — list all subscriptions
router.get('/', adminAuth, (_req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM subscriptions ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

// GET /api/subscriptions/:id — get one
router.get('/:id', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Subscription not found' }); return; }
  res.json(row);
});

// DELETE /api/subscriptions/:id — soft-delete (deactivate)
router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
  const db = getDb();
  const result = db.prepare(
    'UPDATE subscriptions SET is_active = 0 WHERE id = ? AND is_active = 1'
  ).run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Subscription not found or already inactive' });
    return;
  }
  res.json({ message: 'Subscription deactivated' });
});

export default router;
