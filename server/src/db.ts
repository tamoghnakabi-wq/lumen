import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
const dbPath = path.join(config.dataDir, "lumen.db");

export const db = new DatabaseSync(dbPath);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Writers wait rather than fail when another connection (a backup, the CLI) holds the lock.
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");
// Keep the WAL from growing without bound between checkpoints.
db.exec("PRAGMA wal_autocheckpoint = 1000");
db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));

export type Row = Record<string, any>;
type Params = any[];

/** node:sqlite rows have a null prototype; copy them so they behave like plain objects. */
function plain<T extends Row>(row: any): T {
  return { ...row } as T;
}

export function all<T extends Row = Row>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params).map(plain) as T[];
}

export function get<T extends Row = Row>(sql: string, ...params: Params): T | undefined {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}

/** Single-column scalar helper. */
export function pluck<T = any>(sql: string, ...params: Params): T | undefined {
  const row: any = db.prepare(sql).get(...params);
  if (!row) return undefined;
  return Object.values(row)[0] as T;
}

export function exists(sql: string, ...params: Params): boolean {
  return db.prepare(sql).get(...params) !== undefined;
}

/**
 * Wrap fn in a transaction; rolls back if it throws.
 *
 * node:sqlite is synchronous and Node is single threaded, so a transaction that
 * contains no `await` cannot interleave with another request. Nesting is not
 * supported by SQLite, so a nested call joins the outer transaction instead.
 */
let txDepth = 0;

export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  txDepth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    txDepth--;
  }
}

/** SQLite cannot bind booleans. */
export function bit(value: unknown): 0 | 1 {
  return value ? 1 : 0;
}

/** Build an `IN (?, ?, ...)` placeholder list. */
export function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/* ------------------------------------------------------------- migrations */

type Migration = { id: string; up: () => void };

/**
 * Schema changes for databases that already hold data. schema.sql defines the
 * current shape for a fresh install; these bring an older file up to it.
 */
const MIGRATIONS: Migration[] = [
  {
    // Quote reposts. New tables come from schema.sql via CREATE TABLE IF NOT
    // EXISTS; only the added column needs an explicit step here.
    id: "2026-08-14-quote-reposts",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(posts)").map((c) => c.name);
      if (!columns.includes("quoted_post_id")) {
        db.exec("ALTER TABLE posts ADD COLUMN quoted_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL");
      }
      // Outside the branch: a fresh install already has the column from
      // schema.sql but still needs the index.
      db.exec("CREATE INDEX IF NOT EXISTS idx_posts_quoted ON posts(quoted_post_id)");
    },
  },
  {
    // Separate id on purpose: the migration above may already be recorded as
    // applied, and an applied migration never runs again.
    id: "2026-08-14-quote-tombstone",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(posts)").map((c) => c.name);
      if (!columns.includes("is_quote")) {
        db.exec("ALTER TABLE posts ADD COLUMN is_quote INTEGER NOT NULL DEFAULT 0");
      }
      db.exec("UPDATE posts SET is_quote = 1 WHERE quoted_post_id IS NOT NULL AND is_quote = 0");
    },
  },
  {
    // Story replies and reactions. story_reactions comes from schema.sql; only
    // the two message columns need adding to an existing database.
    id: "2026-08-14-story-replies",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
      if (!columns.includes("story_id")) {
        db.exec("ALTER TABLE messages ADD COLUMN story_id TEXT REFERENCES stories(id) ON DELETE SET NULL");
      }
      if (!columns.includes("is_story_reply")) {
        db.exec("ALTER TABLE messages ADD COLUMN is_story_reply INTEGER NOT NULL DEFAULT 0");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_story ON messages(story_id)");
    },
  },
  {
    // Audio calls. The calls table itself comes from schema.sql; the message
    // link needs adding to databases that predate it.
    id: "2026-08-14-audio-calls",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
      if (!columns.includes("call_id")) {
        db.exec("ALTER TABLE messages ADD COLUMN call_id TEXT REFERENCES calls(id) ON DELETE SET NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_id)");
    },
  },
  {
    // Video support: images and videos share the media table.
    id: "2026-08-14-video-media",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(media)").map((c) => c.name);
      const add = (name: string, ddl: string) => {
        if (!columns.includes(name)) db.exec(`ALTER TABLE media ADD COLUMN ${ddl}`);
      };
      add("kind", "kind TEXT NOT NULL DEFAULT 'image'");
      add("status", "status TEXT NOT NULL DEFAULT 'ready'");
      add("duration_ms", "duration_ms INTEGER NOT NULL DEFAULT 0");
      add("has_audio", "has_audio INTEGER NOT NULL DEFAULT 0");
      db.exec("CREATE INDEX IF NOT EXISTS idx_media_status ON media(status)");
    },
  },
  {
    // Sessions and reset tokens used to be stored in the clear.
    id: "2026-08-14-hash-tokens",
    up() {
      const sessionCols = all<{ name: string }>("PRAGMA table_info(sessions)").map((c) => c.name);
      if (sessionCols.includes("token")) {
        // Existing sessions cannot be migrated (the plaintext token is the only
        // copy and we must not keep it), so everyone signs in once more.
        db.exec("DROP TABLE sessions");
        db.exec(`
          CREATE TABLE sessions (
            token_hash    TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL,
            last_used_at  INTEGER NOT NULL DEFAULT 0,
            user_agent    TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX idx_sessions_user ON sessions(user_id);
          CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
        `);
      }
      const resetCols = all<{ name: string }>("PRAGMA table_info(password_resets)").map((c) => c.name);
      if (resetCols.includes("token")) {
        db.exec("DROP TABLE password_resets");
        db.exec(`
          CREATE TABLE password_resets (
            token_hash  TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL,
            used_at     INTEGER
          );
          CREATE INDEX idx_resets_user ON password_resets(user_id);
        `);
      }
    },
  },
  {
    // Activity status and read receipts became opt-out.
    id: "2026-08-23-privacy-controls",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
      if (!columns.includes("show_activity")) {
        db.exec("ALTER TABLE users ADD COLUMN show_activity INTEGER NOT NULL DEFAULT 1");
      }
      if (!columns.includes("read_receipts")) {
        db.exec("ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    // Two-factor authentication with an authenticator app.
    id: "2026-08-23-totp",
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_totp (
          user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          secret       TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          confirmed_at INTEGER,
          last_step    INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS totp_recovery_codes (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash  TEXT NOT NULL,
          used_at    INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, code_hash)
        );
        CREATE TABLE IF NOT EXISTS totp_challenges (
          token_hash TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          user_agent TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_totp_challenges_expiry ON totp_challenges(expires_at);
      `);
    },
  },
  {
    // Calls can now carry video as well as audio.
    id: "2026-08-22-video-calls",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(calls)").map((c) => c.name);
      if (!columns.includes("kind")) {
        db.exec("ALTER TABLE calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio'");
      }
    },
  },
  {
    // Mute: quieten someone without unfollowing or blocking them.
    id: "2026-08-22-mutes",
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutes (
          muter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          muted_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (muter_id, muted_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mutes_muted ON mutes(muted_id);
      `);
    },
  },
  {
    // Usernames became changeable; the timestamp enforces the cooldown.
    id: "2026-08-22-username-changes",
    up() {
      const columns = all<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
      if (!columns.includes("username_changed_at")) {
        db.exec("ALTER TABLE users ADD COLUMN username_changed_at INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
];

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(all<{ id: string }>("SELECT id FROM schema_migrations").map((r) => r.id));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    migration.up();
    run("INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)", migration.id, Date.now());
    console.log(`[lumen] applied migration ${migration.id}`);
  }
}

migrate();

/** Writes a consistent snapshot to `destination`, safe to run while serving. */
export function backupTo(destination: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // VACUUM INTO takes a read lock only; it does not block writers for long.
  db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  return destination;
}

export function checkpoint() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* nothing to checkpoint */
  }
}

export function closeDatabase() {
  checkpoint();
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
