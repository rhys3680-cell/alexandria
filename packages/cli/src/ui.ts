import type { Briefing, BriefingTask, Item, RelatedHit } from '@alexandria/core';

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: number) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);

export const color = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

const STATUS_COLOR: Record<string, (text: string) => string> = {
  raw: color.dim,
  transcribing: color.cyan,
  transcribed: color.cyan,
  organizing: color.yellow,
  organized: color.green,
  failed: color.red,
};

export function statusLabel(status: string): string {
  return (STATUS_COLOR[status] ?? color.dim)(status.padEnd(12));
}

/** `2026-08-12 18:30` in local time. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatItemLine(item: Item): string {
  const title = item.title ?? color.dim(firstLine(item.body) || '(내용 없음)');
  const tags = item.tags.length ? color.blue(item.tags.map((tag) => `#${tag}`).join(' ')) : '';
  const media = item.media ? color.magenta('♪ ') : '';
  return [
    color.dim(item.id.slice(-6)),
    statusLabel(item.status),
    color.dim(formatDate(item.created)),
    `${media}${title}`,
    tags,
  ]
    .filter(Boolean)
    .join('  ');
}

export function formatItemDetail(item: Item): string {
  const lines: string[] = [];
  lines.push(color.bold(item.title ?? '(제목 없음)'));
  lines.push(color.dim(`${item.id}  ·  ${formatDate(item.created)}  ·  ${item.status}  ·  ${item.source}`));
  if (item.lang || item.kind) lines.push(color.dim(`${item.kind ?? '-'} / ${item.lang ?? '-'}`));
  lines.push('');

  if (item.summary) lines.push(`${color.bold('요약')}  ${item.summary}`, '');
  if (item.tags.length) lines.push(`${color.bold('태그')}  ${item.tags.map((t) => `#${t}`).join(' ')}`);
  if (item.keywords.length) lines.push(`${color.bold('키워드')}  ${item.keywords.join(', ')}`);
  if (item.people.length) lines.push(`${color.bold('인물')}  ${item.people.join(', ')}`);
  if (item.tasks.length) {
    lines.push(color.bold('할 일'));
    for (const task of item.tasks) {
      lines.push(`  - ${task.text}${task.due ? color.dim(` (${task.due})`) : ''}${task.owner ? color.dim(` @${task.owner}`) : ''}`);
    }
  }
  if (item.highlights.length) {
    lines.push(color.bold('발췌'));
    for (const highlight of item.highlights) lines.push(color.dim(`  "${highlight}"`));
  }
  if (item.error) lines.push(`${color.red('오류')}  ${item.error}`);

  lines.push('', color.dim('─'.repeat(50)), item.body.trim(), color.dim('─'.repeat(50)));
  lines.push(color.dim(`파일: ${item.path}`));
  if (item.costUsd) lines.push(color.dim(`정리 비용 환산: $${item.costUsd.toFixed(4)}`));
  return lines.join('\n');
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function formatBriefing(briefing: Briefing): string {
  const lines: string[] = [];
  const date = new Date(`${briefing.date}T00:00:00`);
  lines.push(color.bold(`${briefing.date} ${WEEKDAYS[date.getDay()]}요일`));

  const sections: [string, BriefingTask[], (text: string) => string][] = [
    ['지났음', briefing.overdue, color.red],
    ['오늘', briefing.today, color.bold],
    ['곧', briefing.soon, color.yellow],
    ['언젠가', briefing.someday, color.dim],
  ];

  let printedAny = false;
  for (const [label, tasks, paint] of sections) {
    if (!tasks.length) continue;
    printedAny = true;
    lines.push('', paint(`${label} (${tasks.length})`));
    for (const task of tasks) lines.push(formatTask(task));
  }

  if (!printedAny) lines.push('', color.dim('열린 할 일이 없습니다.'));

  if (briefing.doneToday.length) {
    lines.push('', color.green(`오늘 끝냄 (${briefing.doneToday.length})`));
    for (const task of briefing.doneToday) lines.push(color.dim(`  ✓ ${task.text}`));
  }

  if (briefing.recent.length) {
    lines.push('', color.bold(`그동안 정리됨 (${briefing.recent.length})`));
    for (const item of briefing.recent) lines.push(`  ${formatItemLine(item)}`);
  }

  for (const group of briefing.resurfaced) {
    lines.push('', color.magenta(`${group.label} 오늘`));
    for (const item of group.items) lines.push(`  ${formatItemLine(item)}`);
  }

  if (briefing.failed.length || briefing.pending) {
    const parts: string[] = [];
    if (briefing.failed.length) parts.push(color.red(`실패 ${briefing.failed.length}건`));
    if (briefing.pending) parts.push(color.yellow(`대기 ${briefing.pending}건`));
    lines.push('', `${color.bold('점검 필요')}  ${parts.join(' · ')}`);
    for (const item of briefing.failed) {
      lines.push(`  ${color.dim(item.id.slice(-6))} ${item.error ?? ''}`);
    }
  }

  return lines.join('\n');
}

function formatTask(task: BriefingTask): string {
  const reference = color.dim(`${task.itemId.slice(-6)}·${task.index + 1}`);
  const due = task.due ? color.dim(` ${task.due}`) : '';
  const owner = task.owner ? color.dim(` @${task.owner}`) : '';
  return `  ${reference}  ${task.text}${due}${owner}\n      ${color.dim(`↳ ${task.itemTitle}`)}`;
}

export function formatRelated(hits: RelatedHit[]): string {
  if (!hits.length) return color.dim('  관련 기록 없음');

  return hits
    .map((hit) => {
      const badge =
        hit.via === 'both' ? color.green('둘다') : hit.via === 'semantic' ? color.magenta('의미') : color.dim('공유');
      const reason = hit.shared.length
        ? color.dim(`      ↳ 공유: ${hit.shared.slice(0, 5).join(', ')}`)
        : color.dim('      ↳ 내용이 비슷함');
      return `  ${badge} ${formatItemLine(hit.item)}\n${reason}`;
    })
    .join('\n');
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().slice(0, 60);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Single-line progress that only redraws on a TTY. */
export function progressLine(text: string): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r\u001b[2K${text}`);
}

export function endProgressLine(): void {
  if (process.stderr.isTTY) process.stderr.write('\n');
}
