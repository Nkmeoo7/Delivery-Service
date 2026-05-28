# DECISIONS.md

## Storage

**Choice:** SQLite via `better-sqlite3` with WAL mode enabled.

**Alternatives considered:**
- *PostgreSQL* — correct choice for a multi-process or distributed system, but requires a running server and adds operational friction that contradicts "single runnable command." Overkill for this scope.
- *Redis* — fast and natural for queuing, but TTL-based expiry creates a risk of losing delivery attempts if Redis is restarted without persistence configured. Also adds a dependency.
- *Pure in-memory* — ruled out by spec. Would lose all pending deliveries on restart.

**Why SQLite + WAL:**
WAL (Write-Ahead Log) mode is the key insight here. Without WAL, every read from the dashboard would contend with the delivery worker's writes, serializing all DB access. WAL allows concurrent readers without blocking the single writer. `better-sqlite3` uses a synchronous API which makes transaction control explicit and eliminates callback complexity. The database is a single file — zero config, trivially backupable, and survives process restarts by design.

**Tradeoff accepted:** SQLite has a single writer. Under high fan-out load (thousands of subscriptions per event), write throughput could become a bottleneck. At that point, I'd move attempt creation to a batch insert and migrate to Postgres with a proper queue table.

---

## Concurrency / Worker Model

**Choice:** A single `setInterval` poll loop running in the main Node.js process, using `Promise.allSettled` to fan out concurrent HTTP requests without blocking the event loop.

**Alternatives considered:**
- *Worker Threads* — provides real CPU parallelism, but `better-sqlite3` requires careful handling across threads (it's not thread-safe by default). The added complexity of passing attempt data between threads via structured clone isn't worth it for this scope.
- *Child process / separate worker script* — would need either a second SQLite connection (possible with WAL, but requires coordination) or IPC for work distribution. More moving parts, harder crash recovery.
- *BullMQ / pg-boss* — excellent production choices, but BullMQ requires Redis and pg-boss requires Postgres. Both contradict the "single runnable command" constraint.

**Why `setInterval`:**
It shares the same SQLite connection as the API layer, which means transaction consistency on state updates is free. Crash recovery is trivial: on startup, any attempt stuck in `attempting` gets reset to `pending` in a single UPDATE. `Promise.allSettled` ensures one slow subscriber doesn't block others. The poll interval (2s) is configurable.

**Tradeoff accepted:** Bounded throughput (~50 concurrent deliveries per poll cycle by default). A long-running delivery doesn't block the poll loop because it's fire-and-forget, but we do cap concurrency to avoid overwhelming the process.

---

## Retry Policy

**Choice:** Exponential backoff with jitter, capped at 1 hour, max 5 attempts. Formula: `min(2^(n-2) * 10_000ms + rand(0, 5_000ms), 3_600_000ms)`.

**Alternatives considered:**
- *Fixed interval* (e.g., retry every 60s) — simple, but creates thundering-herd: if 100 subscriptions all start failing at the same time (e.g., subscriber deploys an outage), they all retry at the same moment, potentially overwhelming a recovering server.
- *Linear backoff* — better than fixed, but still predictable clustering.
- *Fibonacci backoff* — more gradual than exponential, but less standard and harder to reason about.

**Response classification:**
- `2xx` → delivered, done.
- `4xx` (except 408 and 429) → permanent failure, no retry. A 404 or 403 is a client configuration error — retrying 5 times won't fix a misconfigured URL.
- `408` (Request Timeout) and `429` (Too Many Requests) → retryable, because these are transient infrastructure signals, not application logic errors.
- `5xx` and network errors → retryable.

**Jitter rationale:** Without jitter, all retries for a batch of simultaneous failures fire at identical backoff intervals, creating retry storms. Adding 0–5s of random jitter spreads them out.

**Tradeoff accepted:** Max 5 attempts means a subscriber that's down for >90 seconds total will miss events. Manual retry from the dashboard covers this case for operators who need it.

---

## Payload Signing

**Choice:** HMAC-SHA256 over `${timestamp}.${body}`, delivered as `X-Webhook-Signature: sha256=<hex>`. Timestamp delivered separately as `X-Webhook-Timestamp`.

**Alternatives considered:**
- *Signing body only* — the obvious first approach, but vulnerable to replay attacks. An attacker who captures a legitimate delivery can re-send it indefinitely. Including the timestamp in the signed payload means the signature changes every time.
- *JWT* — JWTs are excellent for identity tokens, not for payload authentication. They add key-management complexity and are non-standard in the webhook ecosystem.
- *Asymmetric signing (RSA/Ed25519)* — would allow subscribers to verify without a shared secret (just publish the public key). Better for large-scale public APIs. Overkill here — adds key distribution complexity.

**Why timestamp in signature (GitHub/Stripe pattern):**
Signing `timestamp.body` means: (1) the subscriber can verify the payload wasn't tampered with (HMAC property), and (2) the subscriber can reject anything where `|now - timestamp| > 5 minutes` to prevent replay attacks. `crypto.timingSafeEqual` is used on both sides to prevent timing-based side-channel attacks during signature comparison.

**Tradeoff accepted:** Shared secret means both sides hold the same key. If the secret is compromised, an attacker can forge signatures. For this scope, per-subscription secrets stored in plaintext in SQLite is acceptable. In production, secrets should be encrypted at rest.

---

## Dashboard Scope

**Choice:** Server-rendered HTML using EJS templates. Four views: subscription list, event log, event detail, subscription detail. Manual retry via a JS `fetch` call.

**Alternatives considered:**
- *React/Vue SPA* — brings a build pipeline, bundler, and client-side state management. For a dashboard that's essentially a read-heavy admin tool, this is significant complexity for no meaningful UX gain over server rendering.
- *HTMX* — interesting middle ground (server-rendered with progressive enhancement), but adds a dependency and learning curve.
- *No dashboard (API only)* — valid, but the spec explicitly requires it and the drill-down into delivery attempts is genuinely useful for debugging.

**Why EJS:**
Zero build step. The templates are rendered server-side with data already fetched from SQLite. Navigation and retry actions work with plain links and fetch calls. The result loads instantly with no client-side hydration delay.

**Scope I deliberately excluded:**
- Real-time updates (SSE/WebSocket) — would complicate the server without being essential for correctness. Documented in README as a future improvement.
- Inline subscription creation form — the spec says this is an admin tool; using `curl` or Postman to create subscriptions is fine.

---

## Deployment Platform

**Choice:** Railway (container hosting).

**What I tried first — Vercel:**
Vercel was the obvious starting point: free tier, one-click GitHub deploy, no config needed. Two problems surfaced immediately.

*Crash on first deployment (`FUNCTION_INVOCATION_FAILED`):* `better-sqlite3` is not pure JavaScript — it compiles a native C++ `.node` binary during `npm install`. The binary compiled on Vercel's build machine was not compatible with Vercel's runtime environment. The function crashed at startup before serving a single request.

*404 on second attempt:* After switching `vercel.json` to point at the compiled `dist/index.js` and adding a `vercel-build: tsc` script, the build succeeded but every route returned `404 NOT_FOUND`. Vercel's serverless bundler could not locate the function output at the expected path.

**Why fixing Vercel further was not worth it:**
Even if both surface errors were resolved, three architectural blockers remained that Vercel cannot solve by design:

- *Background worker won't run.* Vercel freezes the Node.js process between requests. `setInterval` never fires. Events would be written to the DB as `pending` and stay there forever — nothing would ever be delivered.
- *SQLite data is wiped constantly.* Vercel's filesystem is read-only except `/tmp`, and `/tmp` is cleared on every cold start. The entire database would be empty on each new function instance.
- *In-flight guard breaks.* The delivery worker uses a process-level `Set` (`inFlight`) to prevent double-delivering. On serverless, every request gets a fresh process with an empty `Set` — the guard is bypassed and simultaneous duplicate deliveries become possible.

**Why Railway:**
Railway runs a real container — `npm start` executes once and the process stays alive. `setInterval` fires on schedule. SQLite writes to a persistent disk volume that survives restarts. `better-sqlite3` compiles its native binary on the same Linux environment it runs on, eliminating the mismatch.

**Alternatives considered:**
- *Netlify* — same serverless model as Vercel, same three architectural blockers. Ruled out immediately.
- *Render* — nearly identical to Railway (container hosting, persistent disk, free tier). Would have worked equally well.

**Tradeoff accepted:** Railway's free tier keeps the container running at all times, meaning it always uses some RAM even when idle. Vercel would have been cheaper at zero traffic (true scale-to-zero). For an always-on delivery service with a background polling loop, this is not a tradeoff — the container must be running regardless.

