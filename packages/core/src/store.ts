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
  /** Which index produced the hit, so the UI can explain a non-obvious match. */
  via?: 'lexical' | 'semantic' | 'both';
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
    db.prepare('delete from embeddings where item_id = ?').run(id);
    db.prepare('delete from jobs where item_id = ?').run(id);
  });
}

export interface FacetMatch {
  id: string;
  /** The tag, keyword or person shared with the source item. */
  shared: string[];
}

/**
 * Items that share a tag, keyword or named person with `item`.
 *
 * This is the half of "related" that works with semantic search switched off,
 * and it is the half that can explain itself: the overlapping labels are
 * returned so the UI can say why two notes are connected.
 */
export function relatedByFacets(db: Database, item: Item, limit = 20): FacetMatch[] {
  const facets = [...new Set([...item.tags, ...item.keywords, ...item.people])].filter(Boolean);
  if (!facets.length) return [];

  const placeholders = facets.map(() => '?').join(',');
  const branch = (column: string) =>
    `select i.id as id, j.value as value from items i, json_each(i.${column}) j
       where j.value in (${placeholders}) and i.id <> ?`;

  const rows = db
    .prepare([branch('tags'), branch('keywords'), branch('people')].join(' union all '))
    .all(...facets, item.id, ...facets, item.id, ...facets, item.id);

  const shared = new Map<string, Set<string>>();
  for (const raw of rows) {
    const row = raw as { id: string; value: string };
    const bucket = shared.get(row.id) ?? new Set<string>();
    bucket.add(row.value);
    shared.set(row.id, bucket);
  }

  return [...shared.entries()]
    .map(([id, values]) => ({ id, shared: [...values] }))
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, limit);
}

// ------------------------------------------------------------------ vectors

export interface StoredEmbedding {
  id: string;
  vector: Float32Array;
}

export function upsertEmbedding(db: Database, itemId: string, model: string, vector: Float32Array): void {
  db.prepare(
    `insert into embeddings (item_id, model, dims, vector, updated) values (?,?,?,?,?)
     on conflict(item_id) do update set
       model = excluded.model, dims = excluded.dims,
       vector = excluded.vector, updated = excluded.updated`,
  ).run(
    itemId,
    model,
    vector.length,
    // A copy, because the view may be a slice of a larger buffer.
    new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)),
    new Date().toISOString(),
  );
}

export function loadEmbeddings(db: Database, model: string): StoredEmbedding[] {
  const rows = db.prepare('select item_id, vector from embeddings where model = ?').all(model);
  return rows.map((raw) => {
    const row = raw as { item_id: string; vector: Uint8Array };
    const bytes = row.vector;
    return {
      id: row.item_id,
      vector: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    };
  });
}

/** Organized items that have no current-model vector yet. */
export function itemsMissingEmbedding(db: Database, model: string, limit = 500): string[] {
  const rows = db
    .prepare(
      `select i.id as id from items i
       left join embeddings e on e.item_id = i.id and e.model = ?
       where i.status = 'organized' and e.item_id is null
       order by i.created desc limit ?`,
    )
    .all(model, limit);
  return rows.map((row) => String((row as { id: unknown }).id));
}

export function embeddingCount(db: Database, model: string): number {
  const row = db.prepare('select count(*) as n from embeddings where model = ?').get(model) as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Finds an item by where it came from.
 *
 * Bulk import needs this: a second run over the same folder must skip what it
 * already took rather than making a duplicate of every file.
 */
export function findBySourceRef(db: Database, sourceRef: string): Item | undefined {
  const row = db.prepare(`select ${ITEM_COLUMNS} from items where source_ref = ? limit 1`).get(sourceRef);
  return row ? rowToItem(row) : undefined;
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
