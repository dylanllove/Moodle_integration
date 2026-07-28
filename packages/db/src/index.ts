import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "./schema.js";

export * from "./types.js";
export type { DatabaseSync } from "node:sqlite";

let _db: DatabaseSync | null = null;

// This file lives at <repo>/packages/db/src/index.ts, so the repo root is three
// levels up. Anchoring the data dir here (not cwd) keeps the server and any
// helper scripts pointed at the SAME database regardless of where they're run.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Resolve the local data directory (DATA_DIR env or <repo>/data). */
export function dataDir(): string {
  const dir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(REPO_ROOT, "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Open (or create) the local SQLite database and apply the schema. */
export function getDb(): DatabaseSync {
  if (_db) return _db;
  const file = join(dataDir(), "uni-study.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  migrate(db);
  _db = db;
  return db;
}

/** Add columns introduced after a DB was first created (preserves data). */
function migrate(db: DatabaseSync): void {
  const cols = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
    );
  const add = (table: string, col: string, def: string) => {
    if (!cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add("courses", "start_date", "TEXT");
  add("courses", "end_date", "TEXT");
  add("courses", "active", "INTEGER NOT NULL DEFAULT 1");
  add("courses", "active_override", "INTEGER");
  add("assignments", "open_at", "TEXT");
  add("events", "location", "TEXT");
  add("events", "notes", "TEXT");
  add("transcripts", "summary", "TEXT");
}

/** Simple key/value settings helpers. */
export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/**
 * Generic upsert by primary key `id`. Bumps updated_at when the table has it.
 * `cols` are the column names to insert/update (excluding id).
 */
export function upsert(
  table: string,
  row: Record<string, unknown>,
  cols: string[],
): void {
  const db = getDb();
  const allCols = ["id", ...cols];
  const placeholders = allCols.map(() => "?").join(", ");
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(", ");
  const bumpUpdatedAt = cols.includes("updated_at") ? "" : ", updated_at = datetime('now')";
  const sql = `INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}${bumpUpdatedAt}`;
  const values = allCols.map((c) => normalize(row[c]));
  db.prepare(sql).run(...values);
}

type SqlValue = string | number | bigint | Uint8Array | null;

function normalize(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  return v as SqlValue;
}
