import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Alexandria,
  buildBriefing,
  claimNextJob,
  defaultConfig,
  embeddingCount,
  embeddingText,
  enqueueJob,
  extractJsonObject,
  failJob,
  fuseRanks,
  listItems,
  loadEmbeddings,
  openMemoryDatabase,
  parseFrontmatter,
  parseWhisperJson,
  searchItems,
  slugify,
  stringifyFrontmatter,
  toMatchQuery,
  upsertEmbedding,
  upsertItem,
} from '../dist/index.js';

/** Minimal item, so each test only states what it actually cares about. */
function makeItem(overrides = {}) {
  return {
    id: '01TESTITEM0000000000000001',
    schema: 1,
    created: '2026-08-12T04:00:00.000Z',
    updated: '2026-08-12T04:00:00.000Z',
    source: 'manual',
    status: 'organized',
    tags: [],
    keywords: [],
    people: [],
    tasks: [],
    highlights: [],
    body: '',
    path: 'items/2026/08/test.md',
    ...overrides,
  };
}

test('frontmatter survives a round trip', () => {
  const data = { id: 'abc', tags: ['회의', 'STT'], tasks: [{ text: '벤치마크 정리', due: '2026-08-21' }] };
  const body = '본문 첫 줄\n둘째 줄';

  const { data: parsed, body: parsedBody } = parseFrontmatter(stringifyFrontmatter(data, body));

  assert.equal(parsed.id, 'abc');
  assert.deepEqual(parsed.tags, ['회의', 'STT']);
  assert.equal(parsed.tasks[0].due, '2026-08-21');
  assert.equal(parsedBody.trim(), body);
});

test('a document without frontmatter is all body', () => {
  const { data, body } = parseFrontmatter('just text');
  assert.deepEqual(data, {});
  assert.equal(body, 'just text');
});

test('slugify keeps non-latin titles and drops path-hostile characters', () => {
  assert.equal(slugify('회의록: 킥오프/설계 리뷰'), '회의록-킥오프-설계-리뷰');
  assert.equal(slugify('a<b>c:d"e|f?g*h'), 'a-b-c-d-e-f-g-h');
  // Sliced by code point, so a multi-byte title is never cut mid-character.
  assert.ok([...slugify('가'.repeat(80))].length <= 40);
});

test('search queries are quoted so FTS5 syntax cannot leak in', () => {
  assert.equal(toMatchQuery('kickoff meeting'), '"kickoff"* AND "meeting"*');
  assert.equal(toMatchQuery('a-b OR c'), '"a-b"* AND "OR"* AND "c"*');
});

test('the organizer reply parser tolerates fences and surrounding prose', () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('Sure! {"a":1} hope that helps'), '{"a":1}');
  assert.equal(extractJsonObject('no json here'), undefined);
});

test('whisper output becomes text plus timed segments', () => {
  const result = parseWhisperJson(
    JSON.stringify({
      result: { language: 'ko' },
      transcription: [
        { offsets: { from: 0, to: 1500 }, text: ' 안녕하세요' },
        { offsets: { from: 1500, to: 4000 }, text: ' 회의를 시작하겠습니다' },
      ],
    }),
  );

  assert.equal(result.language, 'ko');
  assert.equal(result.text, '안녕하세요 회의를 시작하겠습니다');
  assert.equal(result.segments.length, 2);
  assert.equal(result.durationMs, 4000);
});

test('an item is findable by its own language and by its English keywords', () => {
  const db = openMemoryDatabase();
  upsertItem(
    db,
    makeItem({
      title: '알렉산드리아 킥오프 회의',
      summary: '전사 파이프라인 설계를 리뷰했다.',
      tags: ['킥오프'],
      keywords: ['kickoff meeting', 'transcription pipeline'],
      body: '내일 오후 3시에 킥오프 회의.',
    }),
  );

  assert.equal(searchItems(db, '킥오프').length, 1, '원어 검색');
  assert.equal(searchItems(db, 'kickoff').length, 1, '영어 키워드로 교차 언어 검색');
  assert.equal(searchItems(db, '존재하지않는단어').length, 0);
  db.close();
});

test('CJK without spaces is reachable through the trigram index', () => {
  const db = openMemoryDatabase();
  upsertItem(db, makeItem({ title: 'データ移行の打ち合わせ', body: 'バックアップ手順を確認する。' }));

  assert.equal(searchItems(db, 'データ移行').length, 1);
  assert.equal(searchItems(db, 'バックアップ').length, 1);
  db.close();
});

test('listing filters on tags exactly, not by substring', () => {
  const db = openMemoryDatabase();
  upsertItem(db, makeItem({ id: 'A', tags: ['회의'], path: 'a.md' }));
  upsertItem(db, makeItem({ id: 'B', tags: ['회의록'], path: 'b.md' }));

  assert.deepEqual(
    listItems(db, { tag: '회의' }).map((item) => item.id),
    ['A'],
  );
  db.close();
});

test('a failing job retries, then gives up', () => {
  const db = openMemoryDatabase();
  upsertItem(db, makeItem({ id: 'A', path: 'a.md' }));
  enqueueJob(db, 'A', 'organize');

  for (let attempt = 1; attempt < 3; attempt++) {
    const job = claimNextJob(db);
    assert.equal(job.attempts, attempt);
    assert.equal(failJob(db, job.id, 'boom'), 'pending', '재시도가 남아 있으면 다시 대기');
  }

  const last = claimNextJob(db);
  assert.equal(failJob(db, last.id, 'boom'), 'failed', '재시도 소진 후 종료');
  assert.equal(claimNextJob(db), undefined);
  db.close();
});

/** Stands in for the `claude` CLI so the pipeline can be exercised offline. */
function stubLlm(result) {
  return {
    name: 'stub',
    check: async () => null,
    complete: async () => ({
      text: JSON.stringify(result),
      model: 'stub',
      costUsd: 0.001,
      durationMs: 1,
    }),
  };
}

const KICKOFF = {
  lang: 'ko',
  kind: 'meeting',
  title: '킥오프 회의',
  summary: '킥오프 일정을 잡았다.',
  tags: ['킥오프'],
  keywords: ['kickoff'],
  people: ['김지훈'],
  tasks: [{ text: '벤치마크 정리', due: '2026-08-21' }],
  highlights: [],
};

test('the briefing buckets tasks by due date', () => {
  const db = openMemoryDatabase();
  const now = new Date('2026-08-12T09:00:00');

  upsertItem(
    db,
    makeItem({
      title: '회의',
      tasks: [
        { text: '지난 것', due: '2026-08-10' },
        { text: '오늘 것', due: '2026-08-12' },
        { text: '곧 할 것', due: '2026-08-15' },
        { text: '한참 뒤', due: '2026-09-30' },
        { text: '날짜 없음' },
        { text: '끝낸 것', due: '2026-08-11', done: true, doneAt: '2026-08-12T08:00:00' },
      ],
    }),
  );

  const briefing = buildBriefing(db, { now });

  assert.deepEqual(briefing.overdue.map((task) => task.text), ['지난 것']);
  assert.deepEqual(briefing.today.map((task) => task.text), ['오늘 것']);
  assert.deepEqual(briefing.soon.map((task) => task.text), ['곧 할 것']);
  assert.deepEqual(briefing.someday.map((task) => task.text), ['날짜 없음']);
  assert.deepEqual(briefing.doneToday.map((task) => task.text), ['끝낸 것']);

  // Beyond the horizon: counted as open, but deliberately not surfaced.
  assert.equal(briefing.openTaskCount, 4);
  assert.equal(briefing.overdue[0].itemTitle, '회의');
  assert.equal(briefing.overdue[0].index, 0);
  db.close();
});

test('a task completed yesterday drops out of the briefing entirely', () => {
  const db = openMemoryDatabase();
  upsertItem(
    db,
    makeItem({ tasks: [{ text: '어제 끝냄', done: true, doneAt: '2026-08-11T08:00:00' }] }),
  );

  const briefing = buildBriefing(db, { now: new Date('2026-08-12T09:00:00') });
  assert.equal(briefing.doneToday.length, 0);
  assert.equal(briefing.openTaskCount, 0);
  db.close();
});

test('completing a task is written to the file and survives a reindex', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });

  try {
    const captured = alx.captureText({ text: '킥오프 회의 잡았다.' });
    await alx.processPending();

    const updated = alx.setTaskDone(captured.id, 0, true);
    assert.equal(updated.tasks[0].done, true);
    assert.ok(updated.tasks[0].doneAt);

    const onDisk = fs.readFileSync(path.join(vaultDir, updated.path), 'utf8');
    assert.match(onDisk, /done: true/);

    alx.reindex();
    assert.equal(alx.get(captured.id).tasks[0].done, true);

    // And it can be undone.
    const reopened = alx.setTaskDone(captured.id, 0, false);
    assert.equal(reopened.tasks[0].done, undefined);
    assert.equal(reopened.tasks[0].doneAt, undefined);
    assert.equal(reopened.tasks[0].due, '2026-08-21', '완료 토글이 다른 필드를 지우지 않는다');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('an unknown item or task index is rejected, not silently ignored', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });

  try {
    const captured = alx.captureText({ text: '킥오프 회의 잡았다.' });
    await alx.processPending();

    assert.equal(alx.setTaskDone('없는아이디', 0, true), undefined);
    assert.equal(alx.setTaskDone(captured.id, 99, true), undefined);
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ semantic search

/**
 * A deterministic stand-in for the embedding model: three topic axes, reached
 * through words that do not overlap between document and query. That is
 * precisely the case lexical search cannot serve.
 */
const AXES = {
  storage: ['sqlite', 'database', '데이터베이스'],
  migration: ['migrate', 'migration', '이관'],
  meeting: ['kickoff', '킥오프'],
};

function stubVector(text) {
  const lower = text.toLowerCase();
  const keys = Object.keys(AXES);
  const vector = new Float32Array(keys.length);
  keys.forEach((key, index) => {
    if (AXES[key].some((word) => lower.includes(word.toLowerCase()))) vector[index] = 1;
  });
  const norm = Math.hypot(...vector) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

const stubEmbedder = {
  model: 'stub-model',
  check: async () => null,
  embedPassages: async (texts) => texts.map(stubVector),
  embedQuery: async (text) => stubVector(text),
};

function semanticConfig(vaultDir) {
  const config = defaultConfig(vaultDir);
  return { ...config, search: { ...config.search, semantic: true, model: 'stub-model' } };
}

const ENGLISH_NOTE = {
  lang: 'en',
  kind: 'note',
  title: 'Keep SQLite in the main process',
  summary: 'The renderer never receives a raw handle.',
  tags: ['architecture'],
  keywords: ['sqlite'],
  people: [],
  tasks: [],
  highlights: [],
};

test('rank fusion favours what both indexes agree on', () => {
  // 'b' is second in one list and first in the other; 'a' is first then absent.
  const fused = fuseRanks([
    ['a', 'b', 'c'],
    ['b', 'c', 'd'],
  ]);
  assert.equal(fused[0].id, 'b');
  assert.deepEqual(new Set(fused.map((entry) => entry.id)), new Set(['a', 'b', 'c', 'd']));
  // Scores must decrease monotonically.
  for (let i = 1; i < fused.length; i++) assert.ok(fused[i - 1].score >= fused[i].score);
});

test('embedding text leads with the derived fields and is truncated', () => {
  const item = makeItem({
    title: '제목',
    summary: '요약',
    tags: ['태그'],
    keywords: ['keyword'],
    body: 'x'.repeat(5000),
  });
  const text = embeddingText(item, 100);
  assert.ok(text.startsWith('제목\n요약'));
  assert.equal(text.length, 100);
});

test('vectors survive the round trip through SQLite', () => {
  const db = openMemoryDatabase();
  upsertItem(db, makeItem());
  const vector = stubVector('sqlite');

  upsertEmbedding(db, '01TESTITEM0000000000000001', 'stub-model', vector);
  const [stored] = loadEmbeddings(db, 'stub-model');

  assert.equal(stored.id, '01TESTITEM0000000000000001');
  assert.deepEqual(Array.from(stored.vector), Array.from(vector));
  assert.equal(embeddingCount(db, 'stub-model'), 1);
  assert.equal(embeddingCount(db, 'other-model'), 0, '모델이 다르면 세지 않는다');
  db.close();
});

test('semantic search finds a note that shares no words with the query', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({
    config: semanticConfig(vaultDir),
    llm: stubLlm(ENGLISH_NOTE),
    embedder: stubEmbedder,
  });

  try {
    alx.captureText({ text: 'We keep SQLite in the main process.' });
    await alx.processPending();

    // The organize pass queues the embed job, so a vector already exists.
    assert.equal(alx.stats().embedded, 1);

    const query = '데이터베이스 접근 분리';
    assert.equal((await alx.search(query, 10, 'lexical')).length, 0, '어휘 검색으로는 못 찾는다');

    const hits = await alx.search(query, 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].via, 'semantic');
    assert.equal(hits[0].item.title, 'Keep SQLite in the main process');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('a hit found by both indexes is labelled as such', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({
    config: semanticConfig(vaultDir),
    llm: stubLlm(ENGLISH_NOTE),
    embedder: stubEmbedder,
  });

  try {
    alx.captureText({ text: 'We keep SQLite in the main process.' });
    await alx.processPending();

    const [hit] = await alx.search('sqlite', 10);
    assert.equal(hit.via, 'both');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('search degrades to lexical when the embedder fails', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const failing = {
    ...stubEmbedder,
    embedQuery: async () => {
      throw new Error('model unavailable');
    },
  };
  const alx = new Alexandria({
    config: semanticConfig(vaultDir),
    llm: stubLlm(ENGLISH_NOTE),
    embedder: stubEmbedder,
  });

  try {
    alx.captureText({ text: 'We keep SQLite in the main process.' });
    await alx.processPending();

    // Swap in the broken embedder only for querying.
    Object.defineProperty(alx, 'embedder', { value: failing, configurable: true });

    assert.equal((await alx.search('데이터베이스 접근 분리', 10)).length, 0, '의미 검색은 죽지만 예외는 나지 않는다');
    const lexical = await alx.search('sqlite', 10);
    assert.equal(lexical.length, 1);
    assert.equal(lexical[0].via, 'lexical');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('with semantic search off nothing is embedded and search stays lexical', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({
    config: defaultConfig(vaultDir),
    llm: stubLlm(ENGLISH_NOTE),
    embedder: stubEmbedder,
  });

  try {
    alx.captureText({ text: 'We keep SQLite in the main process.' });
    await alx.processPending();

    assert.equal(alx.stats().embedded, 0);
    assert.equal(alx.stats().semantic, false);
    assert.equal((await alx.search('데이터베이스 접근 분리', 10)).length, 0);
    assert.equal((await alx.search('sqlite', 10))[0].via, 'lexical');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('capture to organized, driven by a stubbed model', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });
  try {
    const captured = alx.captureText({ text: '내일 오후 3시에 김지훈님이랑 킥오프 회의.' });
    assert.equal(captured.status, 'transcribed');
    assert.equal(alx.pendingCount(), 1);

    const summary = await alx.processPending();
    assert.equal(summary.processed, 1);
    assert.equal(summary.failed, 0);

    const organized = alx.get(captured.id);
    assert.equal(organized.status, 'organized');
    assert.equal(organized.title, '킥오프 회의');
    assert.deepEqual(organized.people, ['김지훈']);
    assert.equal(organized.tasks[0].due, '2026-08-21');

    // The file is renamed off the title, and the old path must not linger.
    assert.ok(organized.path.includes('킥오프-회의'), organized.path);
    assert.ok(fs.existsSync(path.join(vaultDir, organized.path)));
    assert.notEqual(organized.path, captured.path);
    assert.ok(!fs.existsSync(path.join(vaultDir, captured.path)));

    assert.equal((await alx.search('kickoff')).length, 1);

    // The markdown files are the source of truth: a wiped index rebuilds.
    alx.db.exec('delete from items; delete from items_fts; delete from items_tri;');
    assert.equal(alx.list().length, 0);
    assert.equal(alx.reindex(), 1);
    assert.equal(alx.get(captured.id).title, '킥오프 회의');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
