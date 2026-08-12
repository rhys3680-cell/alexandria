import type { Database } from './db.js';
import { pendingJobCount } from './jobs.js';
import { listItems } from './store.js';
import type { Item, ItemTask } from './types.js';

export type TaskBucket = 'overdue' | 'today' | 'soon' | 'someday';

export interface BriefingTask extends ItemTask {
  itemId: string;
  itemTitle: string;
  /** Position within the item's own task array; needed to toggle it. */
  index: number;
  bucket: TaskBucket;
}

export interface ResurfacedGroup {
  label: string;
  items: Item[];
}

export interface Briefing {
  /** Local date the briefing was built for, `YYYY-MM-DD`. */
  date: string;
  overdue: BriefingTask[];
  today: BriefingTask[];
  soon: BriefingTask[];
  someday: BriefingTask[];
  doneToday: BriefingTask[];
  openTaskCount: number;
  /** Organized since the last briefing-sized window — "그동안 정리된 것". */
  recent: Item[];
  resurfaced: ResurfacedGroup[];
  failed: Item[];
  pending: number;
}

export interface BriefingOptions {
  now?: Date;
  /** How far ahead counts as "soon". */
  soonDays?: number;
  /** How far back "recently organized" reaches. */
  recentHours?: number;
  /** Cap on undated tasks, newest first — the long tail is not actionable. */
  somedayLimit?: number;
}

/**
 * Builds the "먼저 보여주기" view from what organizing already extracted.
 *
 * Deliberately deterministic: no model call, so opening the app costs nothing
 * and always renders instantly.
 */
export function buildBriefing(db: Database, options: BriefingOptions = {}): Briefing {
  const now = options.now ?? new Date();
  const soonDays = options.soonDays ?? 7;
  const today = localDate(now);
  const soonLimit = localDate(addDays(now, soonDays));

  const overdue: BriefingTask[] = [];
  const dueToday: BriefingTask[] = [];
  const soon: BriefingTask[] = [];
  const someday: BriefingTask[] = [];
  const doneToday: BriefingTask[] = [];

  // Personal-scale data: reading the task-carrying items and bucketing in
  // memory stays well under a millisecond and keeps the SQL simple.
  for (const item of listItems(db, { hasTasks: true, limit: 5000 })) {
    item.tasks.forEach((task, index) => {
      const entry: BriefingTask = {
        ...task,
        itemId: item.id,
        itemTitle: item.title ?? '(제목 없음)',
        index,
        bucket: 'someday',
      };

      if (task.done) {
        if (task.doneAt && localDate(new Date(task.doneAt)) === today) {
          doneToday.push(entry);
        }
        return;
      }

      if (!task.due) {
        someday.push(entry);
      } else if (task.due < today) {
        overdue.push({ ...entry, bucket: 'overdue' });
      } else if (task.due === today) {
        dueToday.push({ ...entry, bucket: 'today' });
      } else if (task.due <= soonLimit) {
        soon.push({ ...entry, bucket: 'soon' });
      }
      // Anything past the "soon" horizon is intentionally not shown.
    });
  }

  byDue(overdue);
  byDue(dueToday);
  byDue(soon);

  return {
    date: today,
    overdue,
    today: dueToday,
    soon,
    someday: someday.slice(0, options.somedayLimit ?? 12),
    doneToday,
    openTaskCount: overdue.length + dueToday.length + soon.length + someday.length,
    recent: listItems(db, {
      organizedSince: addHours(now, -(options.recentHours ?? 48)).toISOString(),
      orderBy: 'organized',
      limit: 8,
    }),
    resurfaced: resurface(db, now),
    failed: listItems(db, { status: 'failed', limit: 5 }),
    pending: pendingJobCount(db),
  };
}

/** Items captured around this date in earlier months and years. */
function resurface(db: Database, now: Date): ResurfacedGroup[] {
  const windows: { label: string; date: Date }[] = [
    { label: '한 달 전', date: addMonths(now, -1) },
    { label: '1년 전', date: addMonths(now, -12) },
  ];

  const groups: ResurfacedGroup[] = [];
  for (const window of windows) {
    const items = listItems(db, {
      since: startOfDay(window.date).toISOString(),
      until: startOfDay(addDays(window.date, 1)).toISOString(),
      limit: 4,
    });
    if (items.length) groups.push({ label: window.label, items });
  }
  return groups;
}

function byDue(tasks: BriefingTask[]): void {
  tasks.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
}

export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMonths(date: Date, months: number): Date {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600_000);
}
