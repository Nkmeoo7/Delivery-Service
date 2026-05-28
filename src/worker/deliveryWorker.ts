import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { sign } from '../services/signing.js';

//types defined
interface AttemptRow {
  id: string;
  event_id: string;
  subscription_id: string;
  attempt_number: number;
  status: string;
  scheduled_at: number;
  target_url: string;
  secret: string | null;
  event_type: string;
  payload: string; // JSON envelope string
  ingested_at: number;
}

// note while we are making webhook these points consideration

// Prevents double-dispatching the same attempt across overlapping poll cycles.
// Without this, if a delivery takes >2s the next poll would see it as 'attempting'
// (we update DB first), so the guard is a belt-and-suspenders safety net.
const inFlight = new Set<string>();

// Exponential backoff with jitter for retries
// Attempt 1 → 0 ms (immediate)
// Attempt N → min(2^(N-2) * 10_000 + jitter, 3_600_000)
//
// This gives: 10s, 20s, 40s, 80s, ... capped at 1 hour.
// Jitter (0–5s) prevents thundering-herd when many subs are down simultaneously.
export function getBackoffMs(attemptNumber: number): number {
  if (attemptNumber <= 1) return 0;
  const base = Math.pow(2, attemptNumber - 2) * 10_000;
  const jitter = Math.random() * 5_000;
  return Math.min(base + jitter, 3_600_000);
}

// http work 

async function deliver(attempt: AttemptRow): Promise<void> {
  const db = getDb();
  const body = attempt.payload;
  const timestamp = Date.now();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event-Id': attempt.event_id,
    'X-Webhook-Event-Type': attempt.event_type,
    'X-Webhook-Delivery-Id': attempt.id,
    'X-Webhook-Timestamp': String(timestamp),
    'X-Webhook-Attempt': String(attempt.attempt_number),
  };

  // Sign only when a secret is configured for this subscription
  if (attempt.secret) {
    headers['X-Webhook-Signature'] = sign(attempt.secret, timestamp, body);
  }

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let outcome: 'delivered' | 'permanent' | 'retryable' = 'retryable';

  // AbortController gives us a clean timeout without relying on the platform's default
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.deliveryTimeoutMs);

  try {
    const response = await fetch(attempt.target_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    responseStatus = response.status;
    responseBody = await response.text().catch(() => null);

    if (responseStatus >= 200 && responseStatus < 300) {
      outcome = 'delivered';
    } else if (
      responseStatus >= 400 &&
      responseStatus < 500 &&
      responseStatus !== 408 && // Request Timeout — infrastructure issue, retry
      responseStatus !== 429    // Too Many Requests — backpressure signal, retry
    ) {
      // Permanent client error (401, 403, 404, 410, etc.)
      // Retrying won't help. Mark abandoned immediately to save quota.
      outcome = 'permanent';
    }
    // 5xx, 408, 429, and network errors → outcome stays 'retryable'
  } catch (err: unknown) {
    const e = err as Error;
    // AbortError = our timeout fired; name check is reliable across Node versions
    errorMessage = e.name === 'AbortError'
      ? `Delivery timed out after ${config.deliveryTimeoutMs}ms`
      : (e.message || 'Network error');
  } finally {
    clearTimeout(timeoutId);
  }

  // --- Write outcome back to DB ---

  if (outcome === 'delivered') {
    db.prepare(`
      UPDATE delivery_attempts
      SET status = 'delivered', attempted_at = ?, response_status = ?, response_body = ?
      WHERE id = ?
    `).run(Date.now(), responseStatus, responseBody, attempt.id);
    return;
  }

  if (outcome === 'permanent') {
    db.prepare(`
      UPDATE delivery_attempts
      SET status = 'abandoned', attempted_at = ?, response_status = ?, response_body = ?,
          error_message = 'Permanent failure (4xx) — no retry'
      WHERE id = ?
    `).run(Date.now(), responseStatus, responseBody, attempt.id);
    return;
  }

  // Retryable failure
  db.prepare(`
    UPDATE delivery_attempts
    SET status = 'failed', attempted_at = ?, response_status = ?, response_body = ?,
        error_message = ?
    WHERE id = ?
  `).run(Date.now(), responseStatus, responseBody, errorMessage, attempt.id);

  if (attempt.attempt_number >= config.maxAttempts) {
    db.prepare(
      `UPDATE delivery_attempts SET status = 'abandoned' WHERE id = ?`
    ).run(attempt.id);
    console.warn(
      `[worker] Attempt ${attempt.id} exhausted max retries (${config.maxAttempts}). Abandoned.`
    );
    return;
  }

  // Schedule next retry attempt as a new row
  const nextNum = attempt.attempt_number + 1;
  const delay = getBackoffMs(nextNum);
  const scheduledAt = Date.now() + Math.round(delay);

  db.prepare(`
    INSERT INTO delivery_attempts
      (id, event_id, subscription_id, attempt_number, status, scheduled_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(uuidv4(), attempt.event_id, attempt.subscription_id, nextNum, scheduledAt);

  console.log(
    `[worker] Attempt ${attempt.id} failed. ` +
    `Next retry (#${nextNum}) in ${Math.round(delay / 1000)}s.`
  );
}

// --- Poll loop ---

async function poll(): Promise<void> {
  const db = getDb();
  const now = Date.now();

  const due = db.prepare(`
    SELECT
      da.id, da.event_id, da.subscription_id, da.attempt_number,
      da.status, da.scheduled_at,
      s.target_url, s.secret,
      e.event_type, e.payload, e.ingested_at
    FROM delivery_attempts da
    JOIN subscriptions s ON s.id = da.subscription_id AND s.is_active = 1
    JOIN events e ON e.id = da.event_id
    WHERE da.status = 'pending'
      AND da.scheduled_at <= ?
    ORDER BY da.scheduled_at ASC
    LIMIT ?
  `).all(now, config.workerConcurrency) as AttemptRow[];

  const deliveries: Promise<void>[] = [];

  for (const attempt of due) {
    if (inFlight.has(attempt.id)) continue;
    inFlight.add(attempt.id);

    // Mark 'attempting' BEFORE the HTTP call.
    // Crash mid-request → row stays 'attempting' → startup reclaims it.
    db.prepare(
      `UPDATE delivery_attempts SET status = 'attempting' WHERE id = ?`
    ).run(attempt.id);

    const p = deliver(attempt)
      .catch(err => {
        console.error(`[worker] Unexpected error delivering ${attempt.id}:`, err);
      })
      .finally(() => {
        inFlight.delete(attempt.id);
      });
    deliveries.push(p);
  }

  if (deliveries.length > 0) {
    await Promise.all(deliveries);
  }
}

// --- Public API ---

export function startWorker(): void {
  const db = getDb();

  // CRASH RECOVERY: On startup, any attempt still in 'attempting' was in-flight
  // when the process died. Reset them to 'pending' so they get retried.
  const recovered = db.prepare(`
    UPDATE delivery_attempts
    SET status = 'pending'
    WHERE status = 'attempting'
  `).run();

  if (recovered.changes > 0) {
    console.log(`[worker] 🔄 Recovered ${recovered.changes} in-flight attempt(s) from prior crash`);
  }

  setInterval(() => {
    poll().catch(err => console.error('[worker] Poll error:', err));
  }, config.workerIntervalMs);

  console.log(`[worker] ✅ Delivery worker started (poll every ${config.workerIntervalMs}ms)`);
}
