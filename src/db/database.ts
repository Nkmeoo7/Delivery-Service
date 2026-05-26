import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    // WAL mode: readers (dashboard) never block the writer (delivery worker)
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Tune for single-process reliability
    db.pragma('synchronous = NORMAL');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id          TEXT    PRIMARY KEY,
      target_url  TEXT    NOT NULL,
      secret      TEXT,
      event_filter TEXT   NOT NULL DEFAULT '*',
      created_at  INTEGER NOT NULL,
      is_active   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS events (
      id          TEXT    PRIMARY KEY,
      event_type  TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      ingested_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id              TEXT    PRIMARY KEY,
      event_id        TEXT    NOT NULL REFERENCES events(id),
      subscription_id TEXT    NOT NULL REFERENCES subscriptions(id),
      attempt_number  INTEGER NOT NULL DEFAULT 1,
      status          TEXT    NOT NULL DEFAULT 'pending',
      scheduled_at    INTEGER NOT NULL,
      attempted_at    INTEGER,
      response_status INTEGER,
      response_body   TEXT,
      error_message   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_due
      ON delivery_attempts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_attempts_event
      ON delivery_attempts(event_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_subscription
      ON delivery_attempts(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_events_ingested
      ON events(ingested_at DESC);
  `);
}

// For tests: reset the singleton so each test can use a fresh in-memory DB
export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export default getDb;
