// Opens the SQLite database and applies the plain SQL files in migrations/ in order.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    });
    applied.push(file);
  }
  return applied;
}

// Runs fn inside one transaction; nested calls join the outer one.
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
