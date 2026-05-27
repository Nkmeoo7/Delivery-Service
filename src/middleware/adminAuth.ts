import { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-admin-key'];
  if (!key || key !== config.adminKey) {
    res.status(401).json({ error: 'Unauthorized — provide X-Admin-Key header' });
    return;
  }
  next();
}
