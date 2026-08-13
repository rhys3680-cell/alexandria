import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addTerms,
  Alexandria,
  buildAskPrompt,
  buildAskSystemPrompt,
  buildBriefing,
  buildWhisperPrompt,
  guessLanguage,
  claimNextJob,
  dictionaryPath,
  loadDictionary,
  removeTerms,
  defaultConfig,
  embeddingCount,
  embeddingText,
  enqueueJob,
  extractJsonObject,
  failJob,
  findWhisperBinary,
  fuseRanks,
  listItems,
  loadEmbeddings,
  openMemoryDatabase,
  parseFrontmatter,
  parseWhisperJson,
  relatedByFacets,
  retryFailedJobs,
  searchItems,
  significantNeighbours,
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

test('the whisper binary is chosen by preference, not by directory order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-bin-'));
  const release = path.join(root, 'Release');
  fs.mkdirSync(release);

  const suffix = process.platform === 'win32' ? '.exe' : '';
  // Current releases ship both, and 'main' sorts first -- a single directory
  // pass would pick the legacy binary.
  fs.writeFileSync(path.join(release, `main${suffix}`), '');
  fs.writeFileSync(path.join(release, `whisper-cli${suffix}`), '');

  assert.equal(path.basename(findWhisperBinary(root)), `whisper-cli${suffix}`);

  fs.rmSync(path.join(release, `whisper-cli${suffix}`));
  assert.equal(path.basename(findWhisperBinary(root)), `main${suffix}`, '없으면 예전 이름으로 내려간다');

  fs.rmSync(root, { recursive: true, force: true });
});

test('the dictionary file round-trips and ignores comments', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-dict-'));
  try {
    assert.deepEqual(loadDictionary(vaultDir), [], '없으면 빈 목록');

    addTerms(vaultDir, ['박서연', '알렉산드리아', '  앱 배포  ', '박서연']);
    assert.deepEqual(loadDictionary(vaultDir), ['박서연', '알렉산드리아', '앱 배포'], '공백 정리, 중복 제거');

    fs.appendFileSync(dictionaryPath(vaultDir), '\n# 주석은 무시\n\n베타 빌드\n', 'utf8');
    assert.ok(loadDictionary(vaultDir).includes('베타 빌드'));
    assert.ok(!loadDictionary(vaultDir).some((term) => term.startsWith('#')));

    removeTerms(vaultDir, ['알렉산드리아']);
    assert.ok(!loadDictionary(vaultDir).includes('알렉산드리아'));
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('the whisper prompt drops whole terms rather than truncating one', () => {
  const terms = ['박서연', '알렉산드리아', '앱 배포'];
  assert.equal(buildWhisperPrompt(terms), '박서연, 알렉산드리아, 앱 배포');

  // Budget fits the first term only; the second must be dropped entirely.
  const clipped = buildWhisperPrompt(terms, 10);
  assert.equal(clipped, '박서연');
  assert.ok(clipped.length <= 10);
  assert.equal(buildWhisperPrompt([], 100), '');
});

test('the dictionary reaches both whisper and the organize prompt', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  addTerms(vaultDir, ['박서연', '앱 배포']);

  let seenPrompt;
  let seenOrganizePrompt;
  const transcriber = {
    name: 'stub',
    check: async () => null,
    transcribe: async (_path, options) => {
      seenPrompt = options?.prompt;
      return { text: '박서현과 에페포 일정', language: 'ko', durationMs: 1000, segments: [{ start: 0, end: 1000, text: '박서현과 에페포 일정' }] };
    },
  };
  const llm = {
    name: 'stub',
    check: async () => null,
    complete: async (request) => {
      seenOrganizePrompt = request.prompt;
      return { text: JSON.stringify(ENGLISH_NOTE), model: 'stub', costUsd: 0, durationMs: 1 };
    },
  };

  const audio = path.join(vaultDir, 'memo.wav');
  fs.writeFileSync(audio, 'not really audio');

  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm, transcriber });
  try {
    alx.captureAudio({ filePath: audio, source: 'mic' });
    await alx.processPending();

    assert.equal(seenPrompt, '박서연, 앱 배포', 'whisper 초기 프롬프트로 전달');
    assert.match(seenOrganizePrompt, /KNOWN TERMS/);
    assert.match(seenOrganizePrompt, /박서연/);
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
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

test('a successful embed retry clears the failed state it left behind', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  let broken = true;
  const flaky = {
    ...stubEmbedder,
    embedPassages: async (texts) => {
      if (broken) throw new Error('model unavailable');
      return texts.map(stubVector);
    },
  };

  const alx = new Alexandria({
    config: semanticConfig(vaultDir),
    llm: stubLlm(ENGLISH_NOTE),
    embedder: flaky,
  });

  try {
    const captured = alx.captureText({ text: 'We keep SQLite in the main process.' });
    await alx.processPending();

    assert.equal(alx.get(captured.id).status, 'failed', '재시도를 모두 쓰면 실패로 남는다');
    assert.equal(alx.stats().embedded, 0);

    broken = false;
    retryFailedJobs(alx.db);
    await alx.processPending();

    const recovered = alx.get(captured.id);
    assert.equal(recovered.status, 'organized', '성공하면 상태가 되돌아온다');
    assert.equal(recovered.error, undefined);
    assert.equal(alx.stats().embedded, 1);
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

test('the spoken language is guessed from the script', () => {
  assert.equal(guessLanguage('안녕하세요, 회의 정리했습니다'), 'ko');
  assert.equal(guessLanguage('こんにちは、打ち合わせです'), 'ja');
  assert.equal(guessLanguage('数据迁移会议'), 'zh');
  assert.equal(guessLanguage('All set for the kickoff'), 'en');
  // Mixed text follows the non-latin script, which is what picks the voice.
  assert.equal(guessLanguage('whisper 모델 비교'), 'ko');
});

// -------------------------------------------------------------------- ask

test('context items reach the prompt with their short ids', () => {
  const item = makeItem({
    id: '01TESTITEM0000000000ABCDEF',
    title: '킥오프 회의',
    summary: '일정을 정했다.',
    tags: ['킥오프'],
    people: ['김지훈'],
    body: 'x'.repeat(3000),
  });

  const prompt = buildAskPrompt({ prompt: '뭘 정했지?', context: [item] });

  assert.match(prompt, /보관소 항목 1개/);
  assert.match(prompt, /\[ABCDEF\] 킥오프 회의/);
  assert.match(prompt, /인물: 김지훈/);
  assert.match(prompt, /이하 생략/, '긴 본문은 잘린다');
  assert.ok(prompt.endsWith('뭘 정했지?'), '질문이 마지막에 온다');
});

test('a question without context carries no context block', () => {
  const prompt = buildAskPrompt({ prompt: '2+2?' });
  assert.equal(prompt, '2+2?');
});

test('the system prompt states the tools actually granted', () => {
  assert.match(buildAskSystemPrompt('none'), /no tools/);
  assert.match(buildAskSystemPrompt('web'), /Cite each claim/);
  assert.match(buildAskSystemPrompt('vault'), /read files inside the vault/);
});

test('ask streams, passes tools through and returns the session for resuming', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const seen = [];
  const llm = {
    name: 'stub',
    check: async () => null,
    complete: async () => {
      throw new Error('스트리밍 경로를 써야 한다');
    },
    stream: async (request, onText) => {
      seen.push(request);
      onText('안녕');
      onText('하세요');
      return { text: '안녕하세요', model: 'stub', costUsd: 0.002, durationMs: 5, sessionId: 'sess-1' };
    },
  };

  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm });
  try {
    let streamed = '';
    const first = await alx.ask({ prompt: '인사해줘', tools: 'web', onText: (t) => (streamed += t) });

    assert.equal(streamed, '안녕하세요', '조각이 순서대로 전달된다');
    assert.equal(first.text, '안녕하세요');
    assert.equal(first.sessionId, 'sess-1');
    assert.equal(seen[0].tools, 'web');
    assert.equal(seen[0].persist, true, '이어가려면 세션이 남아야 한다');

    await alx.ask({ prompt: '한 번 더', resume: first.sessionId, onText: () => {} });
    assert.equal(seen[1].resume, 'sess-1');

    await assert.rejects(() => alx.ask({ prompt: '   ' }), /빈 질문/);
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('a saved answer keeps the question and is queued for organizing', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(ENGLISH_NOTE) });

  try {
    const item = alx.saveAnswer('whisper 최신 버전은?', 'v1.9.2 입니다.');

    assert.equal(item.source, 'assistant');
    assert.match(item.body, /whisper 최신 버전은\?/);
    assert.match(item.body, /v1\.9\.2/);
    assert.equal(alx.pendingCount(), 1, '다른 항목과 똑같이 정리 대기열로 간다');

    await alx.processPending();
    assert.equal(alx.get(item.id).status, 'organized');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('a hand edit lands in the file and is not blanked by omission', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });

  try {
    const captured = alx.captureText({ text: '킥오프 회의 잡았다.' });
    await alx.processPending();
    const before = alx.get(captured.id);
    assert.deepEqual(before.people, ['김지훈']);

    // Only the wrong name is corrected; everything else must survive.
    const updated = alx.updateItem(captured.id, { people: ['박서연'] });
    assert.deepEqual(updated.people, ['박서연']);
    assert.equal(updated.title, before.title, '언급하지 않은 필드는 그대로');
    assert.deepEqual(updated.tags, before.tags);

    const onDisk = fs.readFileSync(path.join(vaultDir, updated.path), 'utf8');
    assert.match(onDisk, /박서연/);
    assert.ok(!onDisk.includes('김지훈'));

    alx.reindex();
    assert.deepEqual(alx.get(captured.id).people, ['박서연'], '재색인 후에도 유지');

    assert.equal(alx.updateItem('없는아이디', { title: 'x' }), undefined);
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('retitling renames the file and drops the old one', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });

  try {
    const captured = alx.captureText({ text: '킥오프 회의 잡았다.' });
    await alx.processPending();
    const before = alx.get(captured.id);

    const updated = alx.updateItem(captured.id, { title: '배포 일정 회의' });

    assert.notEqual(updated.path, before.path);
    assert.ok(updated.path.includes('배포-일정-회의'), updated.path);
    assert.ok(fs.existsSync(path.join(vaultDir, updated.path)));
    assert.ok(!fs.existsSync(path.join(vaultDir, before.path)), '옛 파일은 남지 않는다');
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('reorganize queues the pass again, and refuses an empty item', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm: stubLlm(KICKOFF) });

  try {
    const captured = alx.captureText({ text: '킥오프 회의 잡았다.' });
    await alx.processPending();
    assert.equal(alx.pendingCount(), 0);

    assert.equal(alx.reorganize(captured.id), true);
    assert.equal(alx.pendingCount(), 1);
    assert.equal(alx.reorganize('없는아이디'), false);
  } finally {
    alx.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ related records

/** Unit vector at `degrees` from the x-axis, for building a known spread. */
function atAngle(degrees) {
  const radians = (degrees * Math.PI) / 180;
  return Float32Array.from([Math.cos(radians), Math.sin(radians)]);
}

test('only neighbours above an item\'s own baseline count as related', () => {
  const query = atAngle(0);
  const candidates = [
    { id: 'close', vector: atAngle(5) },
    { id: 'a', vector: atAngle(45) },
    { id: 'b', vector: atAngle(55) },
    { id: 'c', vector: atAngle(60) },
    { id: 'd', vector: atAngle(65) },
    { id: 'e', vector: atAngle(70) },
  ];

  const found = significantNeighbours(candidates, query, 10);
  assert.deepEqual(found.map((entry) => entry.id), ['close']);
});

test('a uniformly similar corpus yields no related records', () => {
  // Everything equidistant: there is no outlier, so the honest answer is none.
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, vector: atAngle(45) }));
  assert.deepEqual(significantNeighbours(candidates, atAngle(0), 10), []);
});

test('too few candidates to establish a baseline yields nothing', () => {
  const candidates = [
    { id: 'close', vector: atAngle(1) },
    { id: 'far', vector: atAngle(80) },
  ];
  assert.deepEqual(significantNeighbours(candidates, atAngle(0), 10), []);
});

test('facet overlap finds shared tags, keywords and people', () => {
  const db = openMemoryDatabase();
  const source = makeItem({
    id: 'SOURCE',
    path: 'source.md',
    tags: ['킥오프'],
    keywords: ['stt'],
    people: ['김지훈'],
  });
  upsertItem(db, source);
  upsertItem(db, makeItem({ id: 'TWO', path: 'two.md', tags: ['킥오프'], people: ['김지훈'] }));
  upsertItem(db, makeItem({ id: 'ONE', path: 'one.md', keywords: ['stt'] }));
  upsertItem(db, makeItem({ id: 'NONE', path: 'none.md', tags: ['무관'] }));

  const matches = relatedByFacets(db, source);

  assert.deepEqual(matches.map((match) => match.id), ['TWO', 'ONE'], '겹치는 개수 순, 자기 자신 제외');
  assert.deepEqual(new Set(matches[0].shared), new Set(['킥오프', '김지훈']));
  assert.deepEqual(matches[1].shared, ['stt']);
  db.close();
});

test('an item with no facets has no facet matches', () => {
  const db = openMemoryDatabase();
  const bare = makeItem({ id: 'BARE', path: 'bare.md' });
  upsertItem(db, bare);
  upsertItem(db, makeItem({ id: 'OTHER', path: 'other.md', tags: ['무언가'] }));

  assert.deepEqual(relatedByFacets(db, bare), []);
  db.close();
});

test('related records explain themselves and exclude the source', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-test-'));
  const results = [
    { ...ENGLISH_NOTE, title: 'Kickoff meeting', tags: ['kickoff'], keywords: ['stt'], people: ['Jihoon'] },
    { ...ENGLISH_NOTE, title: 'Benchmark update', tags: ['kickoff'], keywords: ['benchmark'], people: ['Jihoon'] },
    { ...ENGLISH_NOTE, title: 'Unrelated errand', tags: ['errand'], keywords: ['groceries'], people: [] },
  ];
  let call = 0;
  const llm = {
    name: 'stub',
    check: async () => null,
    complete: async () => ({
      text: JSON.stringify(results[Math.min(call++, results.length - 1)]),
      model: 'stub',
      costUsd: 0,
      durationMs: 1,
    }),
  };

  const alx = new Alexandria({ config: defaultConfig(vaultDir), llm });
  try {
    const first = alx.captureText({ text: 'kickoff' });
    await alx.processPending();
    alx.captureText({ text: 'benchmark' });
    await alx.processPending();
    alx.captureText({ text: 'errand' });
    await alx.processPending();

    const related = alx.related(first.id);

    assert.equal(related.length, 1, '무관한 항목은 빠진다');
    assert.equal(related[0].item.title, 'Benchmark update');
    assert.equal(related[0].via, 'shared');
    assert.deepEqual(new Set(related[0].shared), new Set(['kickoff', 'Jihoon']));
    assert.ok(!related.some((hit) => hit.item.id === first.id), '자기 자신은 제외');
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
