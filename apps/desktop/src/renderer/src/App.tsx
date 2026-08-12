import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Briefing, BriefingTask, Item, SearchHit } from '@alexandria/core';
import type { DoctorCheck, VaultStats } from '../../shared/api.js';

const STATUS_LABEL: Record<string, string> = {
  raw: '대기',
  transcribing: '전사 중',
  transcribed: '정리 대기',
  organizing: '정리 중',
  organized: '정리됨',
  failed: '실패',
};

export function App(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [hits, setHits] = useState<SearchHit[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [stats, setStats] = useState<VaultStats | undefined>(undefined);
  const [briefing, setBriefing] = useState<Briefing | undefined>(undefined);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [nextItems, nextStats, nextBriefing] = await Promise.all([
      window.alexandria.list({ limit: 200 }),
      window.alexandria.stats(),
      window.alexandria.briefing(),
    ]);
    setItems(nextItems);
    setStats(nextStats);
    setBriefing(nextBriefing);
  }, []);

  useEffect(() => {
    void refresh();
    void window.alexandria.doctor().then(setChecks);
    return window.alexandria.onChanged(() => void refresh());
  }, [refresh]);

  // Search runs on a short debounce so every keystroke does not hit SQLite.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void window.alexandria.search(trimmed, 50).then(setHits);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const visible = useMemo(() => (hits ? hits.map((hit) => hit.item) : items), [hits, items]);

  // No selection means the briefing stays on screen — that is the default view,
  // not a fallback.
  const selected = useMemo(
    () =>
      selectedId
        ? visible.find((item) => item.id === selectedId) ?? items.find((item) => item.id === selectedId)
        : undefined,
    [visible, items, selectedId],
  );

  const toggleTask = useCallback(
    async (task: BriefingTask, done: boolean) => {
      await window.alexandria.setTaskDone(task.itemId, task.index, done);
      await refresh();
    },
    [refresh],
  );

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(undefined), 4000);
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      const paths = Array.from(event.dataTransfer.files).map((file) => window.alexandria.pathForFile(file));
      if (!paths.length) return;
      const captured = await window.alexandria.captureFiles(paths);
      showNotice(`${captured.length}개 파일을 수집했습니다.`);
      await refresh();
    },
    [refresh, showNotice],
  );

  const failing = checks.filter((check) => !check.ok);

  return (
    <div className="app" onDrop={(event) => void onDrop(event)} onDragOver={(event) => event.preventDefault()}>
      <header className="header">
        <div className="brand">Alexandria</div>
        <button
          className={selected ? 'today' : 'today active'}
          onClick={() => setSelectedId(undefined)}
          title="오늘 챙길 것들"
        >
          오늘
          {briefing && briefing.overdue.length + briefing.today.length > 0 ? (
            <span className="badge">{briefing.overdue.length + briefing.today.length}</span>
          ) : undefined}
        </button>
        <input
          className="search"
          type="search"
          placeholder="검색 — 어떤 언어로 물어봐도 됩니다"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Recorder onCaptured={refresh} onNotice={showNotice} />
      </header>

      <main className="body">
        <section className="left">
          <Composer onCaptured={refresh} onNotice={showNotice} />
          <ItemList
            items={visible}
            hits={hits}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            searching={Boolean(hits)}
          />
        </section>
        <section className="right">
          {selected ? (
            <ItemDetail
              item={selected}
              onDeleted={async () => {
                await window.alexandria.remove(selected.id);
                setSelectedId(undefined);
                await refresh();
              }}
            />
          ) : briefing ? (
            <BriefingView briefing={briefing} onOpen={setSelectedId} onToggleTask={toggleTask} />
          ) : (
            <Empty />
          )}
        </section>
      </main>

      <footer className="footer">
        <span>{stats ? `${sumStatuses(stats)}건` : '…'}</span>
        <span className={stats?.pending ? 'pending active' : 'pending'}>
          {stats?.pending ? `처리 중 ${stats.pending}건` : '대기 작업 없음'}
        </span>
        <span className="spacer" />
        {notice ? <span className="notice">{notice}</span> : undefined}
        {failing.length ? (
          <span className="warn" title={failing.map((check) => check.detail ?? check.name).join('\n')}>
            ⚠ {failing.length}개 항목 점검 필요
          </span>
        ) : undefined}
        <button className="link" onClick={() => void window.alexandria.revealVault()}>
          보관소 열기
        </button>
        <span className="cost" title="구독 로그인 상태라면 실제 청구가 아니라 사용량 한도 소모량의 환산치입니다.">
          ${stats?.totalCostUsd.toFixed(4) ?? '0.0000'}
        </span>
      </footer>
    </div>
  );
}

function Composer({
  onCaptured,
  onNotice,
}: {
  onCaptured: () => Promise<void>;
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await window.alexandria.captureText(trimmed);
      setText('');
      onNotice('저장했습니다. 정리는 백그라운드에서 진행됩니다.');
      await onCaptured();
    } catch (error) {
      onNotice(`저장 실패: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder="떠오른 것을 그대로 적으세요. 제목·태그·할 일은 알아서 붙습니다."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void save();
        }}
      />
      <div className="composer-actions">
        <span className="hint">Ctrl+Enter 로 저장 · 파일을 끌어다 놓아도 됩니다</span>
        <button onClick={() => void save()} disabled={!text.trim() || saving}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}

function Recorder({
  onCaptured,
  onNotice,
}: {
  onCaptured: () => Promise<void>;
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (blob.size === 0) {
          onNotice('녹음된 소리가 없습니다.');
          return;
        }
        await window.alexandria.captureAudio(await blob.arrayBuffer(), '.webm');
        onNotice('녹음을 저장했습니다. 전사 후 정리됩니다.');
        await onCaptured();
      };

      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
    } catch (error) {
      onNotice(`마이크를 열 수 없습니다: ${(error as Error).message}`);
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = undefined;
    setRecording(false);
  };

  return (
    <button className={recording ? 'record active' : 'record'} onClick={() => (recording ? stop() : void start())}>
      {recording ? `■ ${formatSeconds(seconds)}` : '● 녹음'}
    </button>
  );
}

function ItemList({
  items,
  hits,
  selectedId,
  onSelect,
  searching,
}: {
  items: Item[];
  hits: SearchHit[] | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  searching: boolean;
}): React.JSX.Element {
  if (!items.length) {
    return <p className="empty-list">{searching ? '결과가 없습니다.' : '아직 아무것도 없습니다.'}</p>;
  }

  const snippetFor = (id: string) => hits?.find((hit) => hit.item.id === id)?.snippet;

  return (
    <ul className="list">
      {items.map((item) => (
        <li
          key={item.id}
          className={item.id === selectedId ? 'selected' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <div className="row">
            <span className={`status ${item.status}`}>{STATUS_LABEL[item.status] ?? item.status}</span>
            <span className="date">{formatDate(item.created)}</span>
            {item.media ? <span className="mic">♪</span> : undefined}
          </div>
          <div className="title">{item.title ?? firstLine(item.body) ?? '(내용 없음)'}</div>
          {snippetFor(item.id) ? (
            <div className="snippet">{stripMarks(snippetFor(item.id) ?? '')}</div>
          ) : item.summary ? (
            <div className="snippet">{item.summary}</div>
          ) : undefined}
          {item.tags.length ? (
            <div className="tags">
              {item.tags.slice(0, 4).map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          ) : undefined}
        </li>
      ))}
    </ul>
  );
}

const TASK_SECTIONS: { key: 'overdue' | 'today' | 'soon' | 'someday'; label: string }[] = [
  { key: 'overdue', label: '지났음' },
  { key: 'today', label: '오늘' },
  { key: 'soon', label: '곧' },
  { key: 'someday', label: '언젠가' },
];

function BriefingView({
  briefing,
  onOpen,
  onToggleTask,
}: {
  briefing: Briefing;
  onOpen: (id: string) => void;
  onToggleTask: (task: BriefingTask, done: boolean) => Promise<void>;
}): React.JSX.Element {
  const nothingToShow =
    briefing.openTaskCount === 0 &&
    briefing.recent.length === 0 &&
    briefing.resurfaced.length === 0 &&
    briefing.failed.length === 0;

  return (
    <article className="briefing">
      <h1>{formatBriefingDate(briefing.date)}</h1>

      {nothingToShow ? <p className="placeholder">챙길 것이 없습니다.</p> : undefined}

      {TASK_SECTIONS.map(({ key, label }) => {
        const tasks = briefing[key];
        if (!tasks.length) return undefined;
        return (
          <section key={key} className={`task-group ${key}`}>
            <h2>
              {label} <span className="count">{tasks.length}</span>
            </h2>
            <ul className="task-list">
              {tasks.map((task) => (
                <li key={`${task.itemId}-${task.index}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={(event) => void onToggleTask(task, event.target.checked)}
                    />
                    <span>{task.text}</span>
                  </label>
                  <div className="task-meta">
                    {task.due ? <span className="due">{task.due}</span> : undefined}
                    {task.owner ? <span>@{task.owner}</span> : undefined}
                    <button className="link" onClick={() => onOpen(task.itemId)}>
                      {task.itemTitle}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {briefing.doneToday.length ? (
        <section className="task-group done">
          <h2>
            오늘 끝냄 <span className="count">{briefing.doneToday.length}</span>
          </h2>
          <ul className="task-list">
            {briefing.doneToday.map((task) => (
              <li key={`${task.itemId}-${task.index}`}>
                <label>
                  <input
                    type="checkbox"
                    checked
                    onChange={(event) => void onToggleTask(task, event.target.checked)}
                  />
                  <span className="struck">{task.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : undefined}

      {briefing.recent.length ? (
        <section>
          <h2>그동안 정리됨</h2>
          <ul className="mini-list">
            {briefing.recent.map((item) => (
              <li key={item.id} onClick={() => onOpen(item.id)}>
                <span className="mini-title">{item.title ?? '(제목 없음)'}</span>
                <span className="mini-sub">{item.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : undefined}

      {briefing.resurfaced.map((group) => (
        <section key={group.label}>
          <h2>{group.label} 오늘</h2>
          <ul className="mini-list">
            {group.items.map((item) => (
              <li key={item.id} onClick={() => onOpen(item.id)}>
                <span className="mini-title">{item.title ?? '(제목 없음)'}</span>
                <span className="mini-sub">{item.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {briefing.failed.length ? (
        <section>
          <h2>점검 필요</h2>
          <ul className="mini-list">
            {briefing.failed.map((item) => (
              <li key={item.id} onClick={() => onOpen(item.id)}>
                <span className="mini-title">{item.title ?? firstLine(item.body) ?? item.id.slice(-6)}</span>
                <span className="mini-sub error-text">{item.error}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : undefined}
    </article>
  );
}

function ItemDetail({ item, onDeleted }: { item: Item; onDeleted: () => Promise<void> }): React.JSX.Element {
  return (
    <article className="detail">
      <h1>{item.title ?? '(정리 전)'}</h1>
      <div className="meta">
        <span>{formatDate(item.created)}</span>
        <span>{STATUS_LABEL[item.status] ?? item.status}</span>
        {item.kind ? <span>{item.kind}</span> : undefined}
        {item.lang ? <span>{item.lang}</span> : undefined}
        {item.durationMs ? <span>{formatSeconds(Math.round(item.durationMs / 1000))}</span> : undefined}
      </div>

      {item.error ? <p className="error">{item.error}</p> : undefined}
      {item.summary ? <p className="summary">{item.summary}</p> : undefined}

      {item.tasks.length ? (
        <section>
          <h2>할 일</h2>
          <ul className="tasks">
            {item.tasks.map((task, index) => (
              <li key={index}>
                {task.text}
                {task.due ? <span className="due">{task.due}</span> : undefined}
              </li>
            ))}
          </ul>
        </section>
      ) : undefined}

      {item.people.length ? (
        <section>
          <h2>인물</h2>
          <p>{item.people.join(', ')}</p>
        </section>
      ) : undefined}

      {item.tags.length ? (
        <div className="tags large">
          {item.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : undefined}

      <section>
        <h2>원문</h2>
        <pre className="body-text">{item.body}</pre>
      </section>

      <footer className="detail-footer">
        <code>{item.path}</code>
        <button className="danger" onClick={() => void onDeleted()}>
          삭제
        </button>
      </footer>
    </article>
  );
}

function Empty(): React.JSX.Element {
  return (
    <div className="placeholder">
      <p>왼쪽에 적거나, 녹음하거나, 파일을 끌어다 놓으세요.</p>
      <p className="dim">정리·태깅·검색 색인은 저장 직후 백그라운드에서 처리됩니다.</p>
    </div>
  );
}

function sumStatuses(stats: VaultStats): number {
  return Object.values(stats.byStatus).reduce((sum, count) => sum + count, 0);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** `2026-08-12` → `8월 12일 수요일` */
function formatBriefingDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일`;
}

function formatSeconds(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim().slice(0, 80);
}

/** FTS5 snippets arrive with «» around matches; the list shows plain text. */
function stripMarks(snippet: string): string {
  return snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim();
}
