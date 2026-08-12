import type { Database } from './db.js';
import { transact } from './db.js';
import type { Item, ItemKind, ItemSource, ItemStatus, ItemTask } from './types.js';

export interface ListOptions {
  limit?: number;
  offset?: number;
  status?: ItemStatus;
  kind?: ItemKind;
  lang?: string;
  tag?: string;
  /** ISO timestamp; only items created at or after this point. */
  since?: string;
  /** ISO timestamp; only items created strictly before this point. */
  until?: string;
  /** ISO timestamp; only items organized at or after this point. */
  organizedSince?: string;
  /** Restrict to items that carry at least one task. */
  hasTasks?: boolean;
  orderBy?: 'created' | 'organized';
}

export interface SearchHit {
  item: Item;
  snippet: string;
  score: number;
}

const ITEM_COLUMNS = `id, path, created, updated, source, source_ref, status, lang, kind, title,
  summary, tags, keywords, people, tasks, highlights, media, duration_ms, organized_at, model,
  cost_usd, error, body`;

export function upsertItem(db: Database, item: Item): void {
  transact(db, () => {
    db.prepare(
      `insert into items (${ITEM_COLUMNS}) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set
         path = excluded.path, created = excluded.created, updated = excluded.updated,
         source = excluded.source, source_ref = excluded.source_ref, status = excluded.status,
         lang = excluded.lang, kind = excluded.kind, title = excluded.title,
         summary = excluded.summary, tags = excluded.tags, keywords = excluded.keywords,
         people = excluded.people, tasks = excluded.tasks, highlights = excluded.highlights,
         media = excluded.media, duration_ms = excluded.duration_ms,
         organized_at = excluded.organized_at, model = excluded.model,
         cost_usd = excluded.cost_usd, error = excluded.error, body = excluded.body`,
    ).run(
      item.id,
      item.path,
      item.created,
      item.updated,
      item.source,
      nullable(item.sourceRef),
      item.status,
      nullable(item.lang),
      nullable(item.kind),
      nullable(item.title),
      nullable(item.summary),
      JSON.stringify(item.tags),
      JSON.stringify(item.keywords),
      JSON.stringify(item.people),
      JSON.stringify(item.tasks),
      JSON.stringify(item.highlights),
      nullable(item.media),
      item.durationMs ?? null,
      nullable(item.organizedAt),
      nullable(item.model),
      item.costUsd ?? null,
      nullable(item.error),
      item.body,
    );

    // FTS5 rows have no primary key to upsert against, so replace them.
    db.prepare('delete from items_fts where id = ?').run(item.id);
    db.prepare('delete from items_tri where id = ?').run(item.id);

    const searchableTags = [...item.tags, ...item.keywords, ...item.people].join(' ');
    db.prepare('insert into items_fts (id, title, summary, tags, body) values (?,?,?,?,?)').run(
      item.id,
      item.title ?? '',
      item.summary ?? '',
      searchableTags,
      item.body,
    );
    db.prepare('insert into items_tri (id, text) values (?,?)').run(
      item.id,
      [item.title ?? '', item.summary ?? '', searchableTags, item.body].join('\n'),
    );
  });
}

export function removeItem(db: Database, id: string): void {
  transact(db, () => {
    db.prepare('delete from items where id = ?').run(id);
    db.prepare('delete from items_fts where id = ?').run(id);
    db.prepare('delete from items_tri where id = ?').run(id);
    db.prepare('delete from jobs where item_id = ?').run(id);
  });
}

export function getItem(db: Database, id: string): Item | undefined {
  const row = db.prepare(`select ${ITEM_COLUMNS} from items where id = ?`).get(id);
  return row ? rowToItem(row) : undefined;
}

export function listItems(db: Database, options: ListOptions = {}): Item[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options.lang) {
    where.push('lang = ?');
    params.push(options.lang);
  }
  if (options.since) {
    where.push('created >= ?');
    params.push(options.since);
  }
  if (options.until) {
    where.push('created < ?');
    params.push(options.until);
  }
  if (options.organizedSince) {
    where.push('organized_at >= ?');
    params.push(options.organizedSince);
  }
  if (options.hasTasks) {
    where.push('json_array_length(tasks) > 0');
  }
  if (options.tag) {
    // tags are stored as a JSON array; exists() over json_each keeps it exact.
    where.push("exists (select 1 from json_each(items.tags) where json_each.value = ?)");
    params.push(options.tag);
  }

  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const order = options.orderBy === 'organized' ? 'organized_at desc, created desc' : 'created desc';
  params.push(options.limit ?? 50, options.offset ?? 0);

  const rows = db
    .prepare(`select ${ITEM_COLUMNS} from items ${clause} order by ${order} limit ? offset ?`)
    .all(...params);
  return rows.map(rowToItem);
}

export function searchItems(db: Database, query: string, limit = 30): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const hits = new Map<string, SearchHit>();

  const wordQuery = toMatchQuery(trimmed);
  if (wordQuery) {
    const rows = db
      .prepare(
        `select f.id as id, bm25(items_fts, 8.0, 4.0, 6.0, 1.0) as score,
                snippet(items_fts, 3, '«', '»', '…', 12) as snippet
         from items_fts f
         where items_fts match ?
         order by score
         limit ?`,
      )
      .all(wordQuery, limit);
    collect(db, rows, hits);
  }

  // Trigram needs 3+ characters, and only earns its keep when the word index
  // came up short — which is exactly the CJK / partial-word case.
  if (hits.size < limit && [...trimmed].length >= 3) {
    const rows = db
      .prepare(
        `select t.id as id, bm25(items_tri) as score,
                snippet(items_tri, 1, '«', '»', '…', 12) as snippet
         from items_tri t
         where items_tri match ?
         order by score
         limit ?`,
      )
      .all(`"${trimmed.replace(/"/g, '""')}"`, limit);
    collect(db, rows, hits);
  }

  return [...hits.values()].sort((a, b) => a.score - b.score).slice(0, limit);
}

export function countByStatus(db: Database): Record<string, number> {
  const rows = db.prepare('select status, count(*) as n from items group by status').all();
  const out: Record<string, number> = {};
  for (const row of rows) {
    const record = row as { status?: unknown; n?: unknown };
    out[String(record.status)] = Number(record.n ?? 0);
  }
  return out;
}

export function allTags(db: Database, limit = 100): { tag: string; count: number }[] {
  const rows = db
    .prepare(
      `select json_each.value as tag, count(*) as n
       from items, json_each(items.tags)
       group by tag order by n desc, tag asc limit ?`,
    )
    .all(limit);
  return rows.map((row) => {
    const record = row as { tag?: unknown; n?: unknown };
    return { tag: String(record.tag), count: Number(record.n ?? 0) };
  });
}

function collect(db: Database, rows: unknown[], into: Map<string, SearchHit>): void {
  for (const row of rows) {
    const record = row as { id?: unknown; score?: unknown; snippet?: unknown };
    const id = String(record.id);
    if (into.has(id)) continue;
    const item = getItem(db, id);
    if (!item) continue;
    into.set(id, {
      item,
      snippet: String(record.snippet ?? ''),
      score: Number(record.score ?? 0),
    });
  }
}

/**
 * FTS5 treats bare input as query syntax, so every token is quoted (which
 * neutralises `-`, `*`, `NEAR`, …) and then given an explicit prefix match.
 */
export function toMatchQuery(input: string): string {
  const tokens = input.match(/[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.replace(/"/g, ''))
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"*`)
    .join(' AND ');
}

interface ItemRow {
  id: string;
  path: string;
  created: string;
  updated: string;
  source: string;
  source_ref: string | null;
  status: string;
  lang: string | null;
  kind: string | null;
  title: string | null;
  summary: string | null;
  tags: string;
  keywords: string;
  people: string;
  tasks: string;
  highlights: string;
  media: string | null;
  duration_ms: number | null;
  organized_at: string | null;
  model: string | null;
  cost_usd: number | null;
  error: string | null;
  body: string;
}

function rowToItem(raw: unknown): Item {
  const row = raw as ItemRow;
  return {
    id: row.id,
    schema: 1,
    path: row.path,
    created: row.created,
    updated: row.updated,
    source: row.source as ItemSource,
    sourceRef: row.source_ref ?? undefined,
    status: row.status as ItemStatus,
    lang: row.lang ?? undefined,
    kind: (row.kind as ItemKind | null) ?? undefined,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    tags: parseArray<string>(row.tags),
    keywords: parseArray<string>(row.keywords),
    people: parseArray<string>(row.people),
    tasks: parseArray<ItemTask>(row.tasks),
    highlights: parseArray<string>(row.highlights),
    media: row.media ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    organizedAt: row.organized_at ?? undefined,
    model: row.model ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    error: row.error ?? undefined,
    body: row.body,
  };
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function nullable(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
