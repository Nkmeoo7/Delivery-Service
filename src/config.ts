const isVercel = !!process.env.VERCEL;

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DB_PATH || (isVercel ? '/tmp/webhook.db' : './webhook.db'),
  adminKey: process.env.ADMIN_KEY || 'change-me-in-production',
  maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '5', 10),
  workerIntervalMs: parseInt(process.env.WORKER_INTERVAL_MS || '2000', 10),
  deliveryTimeoutMs: parseInt(process.env.DELIVERY_TIMEOUT_MS || '5000', 10),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '50', 10),
} as const;
