import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Briefing, BriefingTask, Item, RelatedHit, SearchHit, ToolAccess } from '@alexandria/core';
import type { BrowserState, DoctorCheck, VaultStats } from '../../shared/api.js';
import { EditItemDialog } from './components/EditItemDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { Button } from './components/ui/button.js';

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
  const [pane, setPane] = useState<'auto' | 'console' | 'browser'>('auto');

  // Selecting an item from a list should reveal it, so the browser — which
  // floats over the whole pane — steps aside. The console does not, because
  // the selection is what it offers as context.
  const selectItem = useCallback((id: string) => {
    setSelectedId(id);
    setPane((current) => (current === 'browser' ? 'auto' : current));
  }, []);

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
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const actionable = failing.filter((check) => check.fix);

  return (
    <div className="app" onDrop={(event) => void onDrop(event)} onDragOver={(event) => event.preventDefault()}>
      <header className="header">
        <div className="brand">Alexandria</div>
        <button
          className={pane === 'auto' && !selected ? 'today active' : 'today'}
          onClick={() => {
            setPane('auto');
            setSelectedId(undefined);
          }}
          title="오늘 챙길 것들"
        >
          오늘
          {briefing && briefing.overdue.length + briefing.today.length > 0 ? (
            <span className="badge">{briefing.overdue.length + briefing.today.length}</span>
          ) : undefined}
        </button>
        <button
          className={pane === 'console' ? 'today active' : 'today'}
          onClick={() => setPane((current) => (current === 'console' ? 'auto' : 'console'))}
          title="모델과 대화하기"
        >
          대화
        </button>
        <button
          className={pane === 'browser' ? 'today active' : 'today'}
          onClick={() => setPane((current) => (current === 'browser' ? 'auto' : 'browser'))}
          title="앱 안에서 웹 보기"
        >
          웹
        </button>
        <input
          className="search"
          type="search"
          placeholder="검색 — 어떤 언어로 물어봐도 됩니다"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Recorder onCaptured={refresh} onNotice={showNotice} />
        <Button variant="ghost" size="icon" title="설정" onClick={() => setSettingsOpen(true)}>
          ⚙
        </Button>
      </header>

      {actionable.length && !setupDismissed ? (
        <div className="setup-banner">
          <div>
            <strong>아직 준비되지 않은 기능이 있습니다.</strong>
            <ul>
              {actionable.map((check) => (
                <li key={check.name}>
                  {check.name.replace(/\s*\(.*\)/, '')} — {check.detail}
                  <code>{check.fix}</code>
                </li>
              ))}
            </ul>
            <span className="dim">설정 화면에서 바로 설치하거나, 저장소 폴더에서 위 명령을 실행하세요.</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setSettingsOpen(true)}>
              설정 열기
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSetupDismissed(true)}>
              닫기
            </Button>
          </div>
        </div>
      ) : undefined}

      <main className="body">
        <section className="left">
          <Composer onCaptured={refresh} onNotice={showNotice} />
          <ItemList
            items={visible}
            hits={hits}
            selectedId={selected?.id}
            onSelect={selectItem}
            searching={Boolean(hits)}
          />
        </section>
        {/* The console and browser own their full height; only the reading views scroll. */}
        <section className={pane === 'auto' ? 'right' : 'right right-fills'}>
          {pane === 'browser' ? (
            <BrowserPanel
              active
              onNotice={showNotice}
              onCaptured={async (item) => {
                await refresh();
                selectItem(item.id);
              }}
            />
          ) : pane === 'console' ? (
            <Console
              contextItem={selected}
              voiceReady={checks.some((check) => check.name.startsWith('STT') && check.ok)}
              onSaved={refresh}
              onNotice={showNotice}
            />
          ) : selected ? (
            <ItemDetail
              item={selected}
              onOpen={selectItem}
              onChanged={refresh}
              onNotice={showNotice}
              onDeleted={async () => {
                await window.alexandria.remove(selected.id);
                setSelectedId(undefined);
                await refresh();
              }}
            />
          ) : briefing ? (
            <BriefingView briefing={briefing} onOpen={selectItem} onToggleTask={toggleTask} />
          ) : (
            <Empty />
          )}
        </section>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        checks={checks}
        onNotice={showNotice}
      />

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
          <div className="title">{itemLabel(item)}</div>
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

function BrowserPanel({
  active,
  onCaptured,
  onNotice,
}: {
  active: boolean;
  onCaptured: (item: Item) => Promise<void>;
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [state, setState] = useState<BrowserState>({
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  const [address, setAddress] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [edited, setEdited] = useState(false);
  const slotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => window.alexandria.onBrowserState(setState), []);

  // The address bar follows the page unless the user is mid-edit.
  useEffect(() => {
    if (!edited) setAddress(state.url);
  }, [state.url, edited]);

  // The page is a separate view floating over this pane, so its rectangle has
  // to be reported whenever this slot moves or resizes.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    if (!active) {
      void window.alexandria.browserDetach();
      return;
    }

    const report = () => {
      const rect = slot.getBoundingClientRect();
      void window.alexandria.browserAttach({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(slot);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      void window.alexandria.browserDetach();
    };
  }, [active]);

  const go = () => {
    if (!address.trim()) return;
    setEdited(false);
    void window.alexandria.browserNavigate(address);
  };

  const capture = async () => {
    setCapturing(true);
    try {
      const item = await window.alexandria.browserCapture();
      onNotice('페이지를 보관소에 담았습니다. 정리는 백그라운드에서 진행됩니다.');
      await onCaptured(item);
    } catch (error) {
      onNotice(`캡처 실패: ${(error as Error).message}`);
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="nav" disabled={!state.canGoBack} onClick={() => void window.alexandria.browserBack()}>
          ←
        </button>
        <button className="nav" disabled={!state.canGoForward} onClick={() => void window.alexandria.browserForward()}>
          →
        </button>
        <button className="nav" onClick={() => void window.alexandria.browserReload()} title="새로고침">
          ↻
        </button>
        <input
          className="address"
          value={address}
          placeholder="주소 또는 검색어"
          onChange={(event) => {
            setAddress(event.target.value);
            setEdited(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go();
          }}
        />
        <button onClick={() => void capture()} disabled={!state.url || capturing}>
          {capturing ? '담는 중…' : '보관소에 담기'}
        </button>
      </div>

      <div className="browser-slot" ref={slotRef}>
        {!state.url ? (
          <div className="placeholder">
            <p>주소를 입력하거나 검색어를 넣으세요.</p>
            <p className="dim">
              보고 있는 페이지를 그대로 보관소에 담을 수 있습니다. 로그인이 필요한 페이지도 화면에 보이는 대로
              담기므로, URL 만 가져오는 방식으로는 못 읽는 것도 기록으로 남습니다.
            </p>
          </div>
        ) : undefined}
      </div>

      {state.loading ? <div className="browser-status">불러오는 중…</div> : undefined}
    </div>
  );
}

interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  costUsd?: number;
  saved?: boolean;
  failed?: boolean;
  /** Files the model touched, when it had workspace access. */
  changes?: { added: string[]; modified: string[] };
}

const TOOL_MODES: { value: ToolAccess; label: string; hint: string }[] = [
  { value: 'none', label: '빠름', hint: '도구 없음 · 가장 저렴 (~$0.001/회)' },
  { value: 'web', label: '웹', hint: '웹 검색·읽기 · ~$0.01–0.03/회' },
  { value: 'vault', label: '보관소', hint: '보관소 파일 직접 읽기 · ~$0.02/회' },
  {
    value: 'workspace',
    label: '작업공간',
    hint: '작업공간 폴더에 문서·슬라이드·코드를 씁니다 · ~$0.025/회',
  },
];

function Console({
  contextItem,
  voiceReady,
  onSaved,
  onNotice,
}: {
  contextItem: Item | undefined;
  /** False until whisper is installed; the mic is disabled and says so. */
  voiceReady: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [tools, setTools] = useState<ToolAccess>('none');
  const [useContext, setUseContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const sessionRef = useRef<string | undefined>(undefined);
  const streamIdRef = useRef<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Chunks land here and are appended to the assistant turn in flight.
  useEffect(
    () =>
      window.alexandria.onAskChunk((chunk) => {
        if (chunk.id !== streamIdRef.current) return;
        setTurns((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: last.text + chunk.text };
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const send = async (spoken?: string) => {
    const question = (spoken ?? draft).trim();
    if (!question || busy) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = id;
    setDraft('');
    setBusy(true);
    setTurns((current) => [...current, { role: 'user', text: question }, { role: 'assistant', text: '' }]);

    try {
      const result = await window.alexandria.ask({
        id,
        prompt: question,
        tools,
        contextIds: useContext && contextItem ? [contextItem.id] : undefined,
        resume: sessionRef.current,
      });
      sessionRef.current = result.sessionId ?? sessionRef.current;
      if (readAloud && result.text) void window.alexandria.speak(result.text);
      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          // The streamed text can lag the final result; trust the result.
          next[next.length - 1] = {
            ...last,
            text: result.text || last.text,
            costUsd: result.costUsd,
            changes: result.changes,
          };
        }
        return next;
      });
    } catch (error) {
      setTurns((current) => {
        const next = [...current];
        next[next.length - 1] = { role: 'assistant', text: (error as Error).message, failed: true };
        return next;
      });
    } finally {
      streamIdRef.current = undefined;
      setBusy(false);
    }
  };

  const startListening = async () => {
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
        if (blob.size === 0) return;

        setTranscribing(true);
        try {
          const text = await window.alexandria.transcribeVoice(await blob.arrayBuffer(), '.webm');
          // Sent straight through: the transcript shows up as the user's turn,
          // so a misheard question is visible rather than silently answered.
          if (text.trim()) await send(text);
          else onNotice('말소리를 알아듣지 못했습니다.');
        } catch (error) {
          onNotice(`음성 인식 실패: ${(error as Error).message}`);
        } finally {
          setTranscribing(false);
        }
      };

      recorder.start();
      recorderRef.current = recorder;
      setListening(true);
    } catch (error) {
      onNotice(`마이크를 열 수 없습니다: ${(error as Error).message}`);
    }
  };

  const stopListening = () => {
    recorderRef.current?.stop();
    recorderRef.current = undefined;
    setListening(false);
  };

  const save = async (index: number) => {
    const answer = turns[index];
    const question = turns[index - 1];
    if (!answer || !question) return;
    await window.alexandria.saveAnswer(question.text, answer.text);
    setTurns((current) => current.map((turn, i) => (i === index ? { ...turn, saved: true } : turn)));
    onNotice('보관소에 저장했습니다. 정리는 백그라운드에서 진행됩니다.');
    await onSaved();
  };

  const total = turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);

  return (
    <div className="console">
      <div className="console-log">
        {turns.length === 0 ? (
          <div className="placeholder">
            <p>모델에게 바로 물어볼 수 있습니다.</p>
            <p className="dim">
              보관소 내용을 근거로 답하게 하려면 항목을 연 뒤 &quot;이 항목을 문맥으로&quot;를 켜세요. 웹 모드를
              쓰면 자료를 찾아오고, 답변은 보관소에 저장해 정리·검색되게 할 수 있습니다.
            </p>
          </div>
        ) : undefined}

        {turns.map((turn, index) => (
          <div key={index} className={`turn ${turn.role}${turn.failed ? ' failed' : ''}`}>
            <div className="turn-text">
              {turn.text || (busy && index === turns.length - 1 ? <span className="thinking">생각 중…</span> : '')}
            </div>
            {turn.changes && (turn.changes.added.length || turn.changes.modified.length) ? (
              <div className="turn-files">
                {turn.changes.added.map((file) => (
                  <div key={`a-${file}`}>
                    <span className="tag-new">새로 만듦</span> {file}
                  </div>
                ))}
                {turn.changes.modified.map((file) => (
                  <div key={`m-${file}`}>
                    <span className="tag-mod">고침</span> {file}
                  </div>
                ))}
              </div>
            ) : undefined}
            {turn.role === 'assistant' && turn.text && !turn.failed ? (
              <div className="turn-meta">
                {turn.costUsd ? <span>${turn.costUsd.toFixed(4)}</span> : undefined}
                <button className="link" disabled={turn.saved} onClick={() => void save(index)}>
                  {turn.saved ? '저장됨' : '보관소에 저장'}
                </button>
              </div>
            ) : undefined}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="console-input">
        <div className="console-controls">
          {TOOL_MODES.map((mode) => (
            <button
              key={mode.value}
              className={tools === mode.value ? 'chip active' : 'chip'}
              title={mode.hint}
              onClick={() => setTools(mode.value)}
            >
              {mode.label}
            </button>
          ))}
          <button
            className={listening ? 'chip listening' : 'chip'}
            onClick={() => (listening ? stopListening() : void startListening())}
            disabled={transcribing || busy || !voiceReady}
            title={voiceReady ? '말로 물어보기' : '음성 인식이 설치되지 않았습니다: pnpm alx setup whisper'}
          >
            {listening ? '■ 듣는 중' : transcribing ? '옮기는 중…' : '🎤 말하기'}
          </button>
          <label className="context-toggle" title="답변을 소리로 읽어줍니다 (시작까지 2~3초)">
            <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
            읽어주기
          </label>
          {readAloud ? (
            <button className="link" onClick={() => void window.alexandria.stopSpeaking()}>
              그만
            </button>
          ) : undefined}
          {contextItem ? (
            <label className="context-toggle" title={contextItem.title ?? contextItem.id}>
              <input type="checkbox" checked={useContext} onChange={(e) => setUseContext(e.target.checked)} />이 항목을
              문맥으로
            </label>
          ) : undefined}
          <span className="spacer" />
          {total > 0 ? <span className="cost">${total.toFixed(4)}</span> : undefined}
          {turns.length ? (
            <button
              className="link"
              onClick={() => {
                setTurns([]);
                sessionRef.current = undefined;
              }}
            >
              새 대화
            </button>
          ) : undefined}
        </div>
        {tools === 'workspace' ? (
          <p className="workspace-warning">
            모델이 작업공간 폴더 안에서 파일을 만들고 고칩니다. 만든 파일은 아래에 표시됩니다.
          </p>
        ) : undefined}
        <textarea
          value={draft}
          placeholder="무엇이든 물어보세요. Ctrl+Enter 로 보냅니다."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send();
          }}
        />
        <div className="composer-actions">
          <span className="hint">{TOOL_MODES.find((mode) => mode.value === tools)?.hint}</span>
          <button onClick={() => void send()} disabled={!draft.trim() || busy}>
            {busy ? '답변 중…' : '보내기'}
          </button>
        </div>
      </div>
    </div>
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

function RelatedRecords({ itemId, onOpen }: { itemId: string; onOpen: (id: string) => void }): React.JSX.Element | null {
  const [hits, setHits] = useState<RelatedHit[]>([]);

  useEffect(() => {
    let live = true;
    setHits([]);
    void window.alexandria.related(itemId, 5).then((found) => {
      if (live) setHits(found);
    });
    return () => {
      live = false;
    };
  }, [itemId]);

  // Nothing related is a real answer, not an empty state worth showing.
  if (!hits.length) return null;

  return (
    <section>
      <h2>관련 기록</h2>
      <ul className="mini-list">
        {hits.map((hit) => (
          <li key={hit.item.id} onClick={() => onOpen(hit.item.id)}>
            <span className="mini-title">{hit.item.title ?? '(제목 없음)'}</span>
            <span className="mini-sub">
              {hit.shared.length ? `공유: ${hit.shared.slice(0, 5).join(', ')}` : '내용이 비슷함'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItemDetail({
  item,
  onDeleted,
  onOpen,
  onChanged,
  onNotice,
}: {
  item: Item;
  onDeleted: () => Promise<void>;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <article className="detail">
      <h1>{item.title ?? (item.media ? '녹음' : '(정리 전)')}</h1>
      <div className="meta">
        <span>{formatDate(item.created)}</span>
        <span>{STATUS_LABEL[item.status] ?? item.status}</span>
        {item.kind ? <span>{item.kind}</span> : undefined}
        {item.lang ? <span>{item.lang}</span> : undefined}
        {item.durationMs ? <span>{formatSeconds(Math.round(item.durationMs / 1000))}</span> : undefined}
      </div>

      {item.media ? (
        <section className="recording">
          {/* Placed above the transcript on purpose: when transcription fails
              or is still queued, hearing the audio is the only way to know
              whether anything was recorded at all. */}
          <audio controls preload="metadata" src={window.alexandria.mediaUrl(item.media)} />
          <div className="recording-meta">
            <code>{item.media}</code>
            <button className="link" onClick={() => void window.alexandria.revealItemFile(item.media!)}>
              폴더에서 보기
            </button>
          </div>
        </section>
      ) : undefined}

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

      <RelatedRecords itemId={item.id} onOpen={onOpen} />

      <footer className="detail-footer">
        <code>{item.path}</code>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing(true)}>
            고치기
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="사전을 바꿨거나 정리가 마음에 들지 않을 때"
            onClick={async () => {
              await window.alexandria.reorganize(item.id);
              onNotice('다시 정리를 대기열에 넣었습니다.');
              await onChanged();
            }}
          >
            다시 정리
          </Button>
          <Button size="sm" variant="danger" onClick={() => void onDeleted()}>
            삭제
          </Button>
        </div>
      </footer>

      <EditItemDialog item={item} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
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

/** What to call an item before organizing has given it a title. */
function itemLabel(item: Item): string {
  if (item.title) return item.title;
  const line = firstLine(item.body);
  if (line) return line;
  // A recording with no transcript yet is not "empty" — say what it is.
  if (item.media) return item.status === 'failed' ? '녹음 (전사 실패)' : '녹음 (전사 대기)';
  return '(내용 없음)';
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim().slice(0, 80);
}

/** FTS5 snippets arrive with «» around matches; the list shows plain text. */
function stripMarks(snippet: string): string {
  return snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim();
}
