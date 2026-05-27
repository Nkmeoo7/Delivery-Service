# AI_LOG.md

This log documents significant AI interactions during development. For each entry: what I asked, what came back, and what I kept, modified, or rejected — with reasoning.

---

## Entry 1: System Architecture Framing

**What I asked:** I described the full spec and asked the AI to outline a system architecture for a single-process webhook delivery service.

**What came back:** A generic diagram with boxes for "REST API," "Queue," "Worker," and "Database" — essentially the default pattern anyone would sketch on a whiteboard. No discussion of failure modes, crash recovery, or the at-least-once guarantee.

**What I kept/modified/rejected:** I rejected the generic diagram entirely. The interesting questions aren't "what boxes exist" but "where exactly does the durability guarantee begin?" and "what happens to an in-flight delivery when the process crashes?" I restructured the architecture document around four explicit design questions (at-least-once boundary, storage choice, worker model, signing strategy) and made each answer include the alternatives I considered and why I drew the line where I did.

---

## Entry 2: SQLite WAL Mode

**What I asked:** Asked whether `better-sqlite3` or `sqlite3` (async) was the better choice, and whether WAL mode was worth the complexity.

**What came back:** The AI recommended `better-sqlite3` for performance and explained that WAL mode allows concurrent reads alongside writes. It suggested enabling WAL with `db.pragma('journal_mode = WAL')`.

**What I kept:** The `better-sqlite3` recommendation and the WAL pragma. I also added `synchronous = NORMAL` (the AI's suggestion for balancing durability and performance in WAL mode) after verifying it was appropriate for a single-process non-critical system. The core insight — that WAL prevents dashboard reads from blocking the delivery worker — was exactly right and I incorporated it directly into DECISIONS.md with that framing.

**What I modified:** The AI didn't mention the `resetDb()` hook needed for test isolation. I added that myself after realizing the singleton pattern would cause test state to bleed between test files.

---

## Entry 3: Retry Response Classification

**What I asked:** Should 408 (Request Timeout) and 429 (Too Many Requests) be retried or treated as permanent failures?

**What came back:** The AI's initial suggestion was to treat all 4xx as permanent failures to keep the logic simple. It noted that "4xx means the client did something wrong."

**What I rejected:** This answer. A 408 is a network/infrastructure timeout — the server timed out waiting for the request, often a transient condition. A 429 is an explicit backpressure signal from the subscriber asking us to slow down. Treating either as a permanent "client bug" is wrong. I kept 4xx permanent for 400, 401, 403, 404, 410, etc. (genuinely unrecoverable) but added 408 and 429 as retryable with the same backoff. This is also what Stripe and GitHub's own webhook retry documentation recommend. I documented this reasoning in DECISIONS.md.

---

## Entry 4: Jitter Implementation

**What I asked:** Asked for a backoff formula that avoids thundering-herd, given the constraint that many subscriptions might fail simultaneously (e.g., subscriber deploys go down).

**What came back:** The AI provided `min(2^n * baseMs + Math.random() * jitterMs, capMs)` — the standard "full jitter" approach. It also mentioned "decorrelated jitter" as an alternative that provides better spread.

**What I kept:** The full jitter formula, but I modified the base calculation. The AI used attempt number `n` starting at 0, which produces a 0ms base for the first retry. I shifted it to `2^(n-2) * 10_000` so attempt 1 is immediate (0ms), attempt 2 is ~10s, attempt 3 is ~20s, etc. — a more intuitive progression that the spec's hint aligns with. I also chose 0–5s jitter (not the 0–base jitter the AI suggested) because `base * random()` can produce near-zero jitter on early attempts.

---

## Entry 5: Fan-out Transaction Design

**What I asked:** Should the fan-out (creating one delivery attempt per matching subscription) happen inside the same transaction as the event insert, or asynchronously after acknowledging the request?

**What came back:** The AI suggested doing it asynchronously — return 202 quickly, then do the matching in the background. It argued this keeps the ingest endpoint fast.

**What I rejected:** This is exactly wrong for at-least-once semantics. If the process crashes between returning 202 and completing the fan-out, events are permanently lost. The whole point of persisting to SQLite before returning 202 is to move the durability boundary to before the acknowledgment. I kept the fan-out inside the same transaction as the event insert. The ingest endpoint is still fast because SQLite writes are microsecond-level for a small number of rows, and "fast" at the cost of durability is the wrong tradeoff here. This is documented in the system diagram comments.

---

## Entry 6: In-flight Guard

**What I asked:** How do I prevent double-dispatching the same delivery attempt across overlapping poll cycles?

**What came back:** The AI suggested using a database-level lock (BEGIN EXCLUSIVE TRANSACTION) to claim attempts atomically, then releasing them after delivery.

**What I modified:** The AI's approach would work but adds write-lock contention that could block dashboard reads even in WAL mode (exclusive transactions bypass WAL). Instead, I use two layers: (1) updating the attempt status to `'attempting'` before making the HTTP call (so the next poll cycle sees it as in-progress and skips it), and (2) an in-memory `Set<string>` as a belt-and-suspenders guard for the case where the status update and the next poll race within the same process. The `Set` is cheap and avoids any additional DB locking. The AI's suggestion was sound for a multi-process system; my approach is better for a single-process one.

---

## Entry 7: Dashboard Framework Choice

**What I asked:** Should I use HTMX, a React SPA, or server-rendered EJS for the dashboard?

**What came back:** The AI recommended React with Vite for "a better user experience" and "component reusability."

**What I rejected:** React + Vite adds a build pipeline, client-side routing, and state management to what is fundamentally a read-heavy admin table view. The spec explicitly says "CSS is not graded" and "a table view and detail view is enough." I chose EJS server-rendered templates because: zero build step, loads instantly, works without JavaScript for most views, and the retry action is a simple fetch call. I documented this explicitly in DECISIONS.md as a deliberate scope decision, not a capability gap.

---

## Entry 8: Crash Recovery Strategy

**What I asked:** What happens to a delivery that's in-flight (HTTP request sent) when the process crashes mid-request?

**What came back:** The AI suggested tracking a "last heartbeat" timestamp per attempt and marking anything older than N seconds as crashed.

**What I modified:** The heartbeat approach requires a background timer to update timestamps and a separate check on startup — more moving parts. My approach is simpler: I update the attempt status to `'attempting'` before making the HTTP call. If the process crashes, the row stays in `'attempting'`. On startup, a single `UPDATE ... WHERE status = 'attempting'` resets all of them to `'pending'`. The cost is potential duplicate delivery (the HTTP request may have completed before the crash), but that's inherent to at-least-once semantics and subscribers should be idempotent. I log the count of recovered attempts on startup so operators can see it happened. The AI's heartbeat idea would be necessary in a multi-worker scenario; for single-process, startup recovery is cleaner.

---
## Entry 8: Polishing the Project & better docs
After writing the readme,Ai log and Decision, I fell they are missing the format and technical writing.
**What I asked:** Act as Advanced documentation maker,I have already written the files *.md.Make them sounds technical in simple grammer so its easy to understand for reader.
Please provide the responce in the format as given below(I putted the format for each .md file as the way answer wanted).
**What came back:** The AI responced with the corrected format of README,AI_lOG,DECISION.
**What I modified:** The Responce miss the lots of things like the architecture diagram and key details of Retry to mention in README.In the AI log and Decision, it elobrated a bit extra so i cut it down some part there.

