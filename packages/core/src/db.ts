import './suppress-warnings.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { CONFIG_DIRNAME } from './config.js';

// Loaded through `require`, not a static `import`: builtin modules are linked
// before any module body runs, so a static import would emit the experimental
// warning before ./suppress-warnings.js ever had a chance to install its filter.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Database = DatabaseSyncType;

const MIGRATIONS: string[] = [
  // 1 — items, full-text indexes, job queue
  `
  create table items (
    id           text primary key,
    path         text not null,
    created      text not null,
    updated      text not null,
    source       text not null,
    source_ref   text,
    status       text not null,
    lang         text,
    kind         text,
    title        text,
    summary      text,
    tags         text not null default '[]',
    keywords     text not null default '[]',
    people       text not null default '[]',
    tasks        text not null default '[]',
    highlights   text not null default '[]',
    media        text,
    duration_ms  integer,
    organized_at text,
    model        text,
    cost_usd     real,
    error        text,
    body         text not null default ''
  );
  create index items_created_idx on items (created desc);
  create index items_status_idx  on items (status);

  -- Word-ish matching. Good for space-delimited scripts (ko, en, ...).
  create virtual table items_fts using fts5 (
    id UNINDEXED, title, summary, tags, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  -- Substring matching, which is how we stay usable for scripts that do not
  -- put spaces between words (ja, zh). Needs a 3+ character query.
  create virtual table items_tri using fts5 (
    id UNINDEXED, text,
    tokenize = 'trigram'
  );

  create table jobs (
    id         integer primary key autoincrement,
    item_id    text not null,
    type       text not null,
    state      text not null default 'pending',
    attempts   integer not null default 0,
    last_error text,
    created    text not null,
    updated    text not null,
    unique (item_id, type)
  );
  create index jobs_state_idx on jobs (state, id);
  `,

  // 2 — semantic search vectors
  `
  create table embeddings (
    item_id text primary key,
    model   text not null,
    dims    integer not null,
    vector  blob not null,
    updated text not null
  );
  create index embeddings_model_idx on embeddings (model);
  `,
];

export function databasePath(vaultRoot: string): string {
  return path.join(vaultRoot, CONFIG_DIRNAME, 'index.db');
}

export function openDatabase(vaultRoot: string): Database {
  const file = databasePath(vaultRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = WAL;');
  db.exec('pragma foreign_keys = ON;');
  db.exec('pragma busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function openMemoryDatabase(): Database {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.prepare('pragma user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    db.exec('begin');
    try {
      db.exec(sql);
      // pragma does not accept bound parameters, and `version` is a loop
      // counter over a literal array, so interpolation is safe here.
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transact<T>(db: Database, fn: () => T): T {
  db.exec('begin');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}
