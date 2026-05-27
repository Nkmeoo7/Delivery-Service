import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getDb } from './db/database.js';
import subscriptionsRouter from './api/subscriptions.js';
import eventsRouter from './api/events.js';
import attemptsRouter from './api/attempts.js';
import dashboardRouter from './dashboard/router.js';
import { startWorker } from './worker/deliveryWorker.js';

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// EJS for the dashboard
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'dashboard/views'));

// API routes (protected by X-Admin-Key middleware within each router)
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/attempts', attemptsRouter);

// Dashboard (no auth — it's a read/action UI, admin-only environment assumed)
app.use('/dashboard', dashboardRouter);

// Root → dashboard
app.get('/', (_req, res) => res.redirect('/dashboard'));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Initialize DB (runs migration on first call)
getDb();

// Start delivery worker
startWorker();

const server = app.listen(config.port, () => {
  console.log(`\n🚀 Webhook Delivery Service`);
  console.log(`   API:       http://localhost:${config.port}/api`);
  console.log(`   Dashboard: http://localhost:${config.port}/dashboard`);
  console.log(`   Admin key: ${config.adminKey}\n`);
});

export { app, server };
export default app;
