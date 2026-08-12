import type { Database } from './db.js';

export type JobType = 'transcribe' | 'organize' | 'embed';
export type JobState = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: number;
  itemId: string;
  type: JobType;
  state: JobState;
  attempts: number;
  lastError?: string;
}

export const MAX_ATTEMPTS = 3;

export function enqueueJob(db: Database, itemId: string, type: JobType): void {
  const now = new Date().toISOString();
  db.prepare(
    `insert into jobs (item_id, type, state, attempts, created, updated)
     values (?, ?, 'pending', 0, ?, ?)
     on conflict (item_id, type) do update set
       state = 'pending', attempts = 0, last_error = null, updated = excluded.updated`,
  ).run(itemId, type, now, now);
}

/** Atomically takes the oldest pending job and marks it running. */
export function claimNextJob(db: Database): Job | undefined {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `update jobs set state = 'running', attempts = attempts + 1, updated = ?
       where id = (select id from jobs where state = 'pending' order by id limit 1)
       returning id, item_id, type, state, attempts, last_error`,
    )
    .get(now);
  return row ? rowToJob(row) : undefined;
}

export function completeJob(db: Database, id: number): void {
  db.prepare("update jobs set state = 'done', last_error = null, updated = ? where id = ?").run(
    new Date().toISOString(),
    id,
  );
}

/**
 * Marks a failed attempt. The job goes back to `pending` while retries remain,
 * so a transient CLI hiccup does not permanently strand an item.
 */
export function failJob(db: Database, id: number, error: string, maxAttempts = MAX_ATTEMPTS): JobState {
  const now = new Date().toISOString();
  const row = db.prepare('select attempts from jobs where id = ?').get(id) as
    | { attempts?: number }
    | undefined;
  const attempts = Number(row?.attempts ?? maxAttempts);
  const state: JobState = attempts >= maxAttempts ? 'failed' : 'pending';
  db.prepare('update jobs set state = ?, last_error = ?, updated = ? where id = ?').run(
    state,
    error.slice(0, 2000),
    now,
    id,
  );
  return state;
}

export function pendingJobCount(db: Database): number {
  const row = db.prepare("select count(*) as n from jobs where state in ('pending','running')").get() as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

export function listJobs(db: Database, state?: JobState): Job[] {
  const rows = state
    ? db.prepare('select id, item_id, type, state, attempts, last_error from jobs where state = ? order by id').all(state)
    : db.prepare('select id, item_id, type, state, attempts, last_error from jobs order by id').all();
  return rows.map(rowToJob);
}

/**
 * Jobs left `running` by a crash would otherwise never be picked up again.
 * Called on startup.
 */
export function requeueStuckJobs(db: Database): number {
  const result = db
    .prepare("update jobs set state = 'pending', updated = ? where state = 'running'")
    .run(new Date().toISOString());
  return Number(result.changes);
}

export function retryFailedJobs(db: Database): number {
  const result = db
    .prepare("update jobs set state = 'pending', attempts = 0, updated = ? where state = 'failed'")
    .run(new Date().toISOString());
  return Number(result.changes);
}

function rowToJob(raw: unknown): Job {
  const row = raw as {
    id: number;
    item_id: string;
    type: string;
    state: string;
    attempts: number;
    last_error: string | null;
  };
  return {
    id: Number(row.id),
    itemId: row.item_id,
    type: row.type as JobType,
    state: row.state as JobState,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? undefined,
  };
}
