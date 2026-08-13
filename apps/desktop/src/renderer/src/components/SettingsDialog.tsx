import { useEffect, useState } from 'react';
import type { AlexandriaConfig } from '@alexandria/core';
import type { DoctorCheck, SetupProgress } from '../../shared/api.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.js';
import { Input, Label, Textarea } from './ui/input.js';

const LLM_MODELS = ['sonnet', 'haiku', 'opus'];
const EFFORTS = ['low', 'medium', 'high'];
const WHISPER = [
  { value: 'base', label: 'base · ~142 MB · 빠름, 한국어 고유명사 오류' },
  { value: 'small', label: 'small · ~466 MB · 기본값' },
  { value: 'medium', label: 'medium · ~1.5 GB · 더 정확, 느림' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo · ~1.6 GB' },
];
const EMBEDDERS = [
  { value: 'Xenova/multilingual-e5-small', label: 'e5-small · ~60 MB · rank1 4/10' },
  { value: 'Xenova/multilingual-e5-base', label: 'e5-base · ~110 MB · rank1 7/10 · 기본값' },
  { value: 'Xenova/bge-m3', label: 'bge-m3 · ~570 MB · rank1 10/10 · 교차 언어 최상' },
];

/**
 * Everything that was CLI-only until now — including the downloads, since
 * hitting a feature that silently needs `alx setup whisper` is exactly how a
 * first run goes wrong.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  checks,
  onNotice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checks: DoctorCheck[];
  onNotice: (message: string) => void;
}): React.JSX.Element {
  const [config, setConfig] = useState<AlexandriaConfig | undefined>(undefined);
  const [terms, setTerms] = useState('');
  const [progress, setProgress] = useState<SetupProgress | undefined>(undefined);
  const [installing, setInstalling] = useState(false);
  const [whisperModel, setWhisperModel] = useState('small');

  useEffect(() => {
    if (!open) return;
    void window.alexandria.getConfig().then((next) => {
      setConfig(next);
      setWhisperModel(guessWhisperModel(next));
    });
    void window.alexandria.getDictionary().then((list) => setTerms(list.join('\n')));
  }, [open]);

  useEffect(
    () =>
      window.alexandria.onSetupProgress((next) => {
        setProgress(next);
        if (next.done) {
          setInstalling(false);
          onNotice(next.error ? `설치 실패: ${next.error}` : next.message);
        }
      }),
    [onNotice],
  );

  if (!config) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>설정</DialogTitle>
          <p className="text-sm text-fg-dim">불러오는 중…</p>
        </DialogContent>
      </Dialog>
    );
  }

  const patch = async (next: Parameters<typeof window.alexandria.setConfig>[0]) => {
    const saved = await window.alexandria.setConfig(next);
    setConfig(saved);
  };

  const saveDictionary = async () => {
    const list = terms
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    await window.alexandria.setDictionary(list);
    onNotice(`사전 ${list.length}개를 저장했습니다. 다음 전사부터 반영됩니다.`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>
            보관소 폴더의 설정 파일에 저장됩니다. 모델을 바꾸면 앱을 다시 시작해야 적용됩니다.
          </DialogDescription>
        </DialogHeader>

        <Section title="보관소">
          <div className="flex items-center gap-2">
            <Input readOnly value={config.vaultDir} className="font-mono text-xs" />
            <Button variant="ghost" onClick={() => void window.alexandria.revealVault()}>
              열기
            </Button>
          </div>
        </Section>

        <Section title="사전" hint="자주 쓰는 이름·용어를 한 줄에 하나씩. 전사 정확도에 가장 크게 영향을 줍니다.">
          <Textarea rows={5} value={terms} onChange={(event) => setTerms(event.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void saveDictionary()}>
              사전 저장
            </Button>
          </div>
        </Section>

        <Section title="정리" hint="호출당 비용이 여기서 결정됩니다.">
          <div className="flex gap-2">
            <Field label="모델">
              <Select
                value={config.llm.model}
                options={LLM_MODELS.map((m) => ({ value: m, label: m }))}
                onChange={(model) => void patch({ llm: { model } })}
              />
            </Field>
            <Field label="사고 수준">
              <Select
                value={config.llm.effort}
                options={EFFORTS.map((e) => ({ value: e, label: e }))}
                onChange={(effort) => void patch({ llm: { effort: effort as 'low' } })}
              />
            </Field>
          </div>
        </Section>

        <Section title="음성 인식" hint="사전과 함께 쓰면 작은 모델로도 충분한 경우가 많습니다.">
          <div className="flex items-end gap-2">
            <Field label="모델" grow>
              <Select
                value={whisperModel}
                options={WHISPER}
                onChange={setWhisperModel}
              />
            </Field>
            <Button
              disabled={installing}
              onClick={() => {
                setInstalling(true);
                setProgress(undefined);
                void window.alexandria.runSetupWhisper(whisperModel);
              }}
            >
              {installing ? '설치 중…' : '설치'}
            </Button>
          </div>
        </Section>

        <Section title="의미 검색" hint="표현이 달라도 찾습니다. 임베딩은 전부 기기 안에서 계산되어 비용이 없습니다.">
          <div className="flex items-end gap-2">
            <Field label="모델" grow>
              <Select
                value={config.search.model}
                options={EMBEDDERS}
                onChange={(model) => void patch({ search: { model } })}
              />
            </Field>
            <Button
              disabled={installing}
              onClick={() => {
                setInstalling(true);
                setProgress(undefined);
                void window.alexandria.runSetupEmbeddings(config.search.model);
              }}
            >
              {config.search.semantic ? '다시 설치' : '켜기'}
            </Button>
          </div>
          <p className="text-xs text-fg-dim">현재 {config.search.semantic ? '켜짐' : '꺼짐'}</p>
        </Section>

        {progress ? (
          <div className="rounded-card border border-line bg-panel-alt px-3 py-2 text-xs">
            <div className={progress.error ? 'text-danger' : 'text-fg-dim'}>{progress.message}</div>
            {progress.total ? (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-line">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.round(((progress.received ?? 0) / progress.total) * 100)}%` }}
                />
              </div>
            ) : undefined}
          </div>
        ) : undefined}

        <Section title="감시 폴더" hint="여기에 파일이 생기면 자동으로 수집합니다. `alx watch` 가 켜져 있을 때 동작합니다.">
          <div className="grid gap-1.5">
            {config.ingest.watchDirs.length === 0 ? (
              <p className="text-xs text-fg-dim">지정된 폴더가 없습니다.</p>
            ) : (
              config.ingest.watchDirs.map((dir) => (
                <div key={dir} className="flex items-center gap-2">
                  <code className="flex-1 truncate text-xs text-fg-dim">{dir}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void patch({
                        ingest: { watchDirs: config.ingest.watchDirs.filter((entry) => entry !== dir) },
                      })
                    }
                  >
                    빼기
                  </Button>
                </div>
              ))
            )}
            <div>
              <Button
                size="sm"
                onClick={async () => {
                  const picked = await window.alexandria.pickFolder();
                  if (picked && !config.ingest.watchDirs.includes(picked)) {
                    await patch({ ingest: { watchDirs: [...config.ingest.watchDirs, picked] } });
                  }
                }}
              >
                폴더 추가
              </Button>
            </div>
          </div>
        </Section>

        <Section title="점검">
          <ul className="grid gap-1 text-xs">
            {checks.map((check) => (
              <li key={check.name} className="flex gap-2">
                <span className={check.ok ? 'text-ok' : 'text-danger'}>{check.ok ? 'OK' : '없음'}</span>
                <span className="text-fg-dim">
                  {check.name} {check.detail ? `— ${check.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="grid gap-2 border-t border-line pt-3 first-of-type:border-t-0 first-of-type:pt-0">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-dim">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-fg-dim opacity-80">{hint}</p> : undefined}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  grow,
  children,
}: {
  label: string;
  grow?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={grow ? 'grid flex-1 gap-1.5' : 'grid gap-1.5'}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * A native select rather than a Radix one: it is a short list, it is already
 * accessible and keyboard-driven, and it avoids another dependency.
 */
function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** The config stores a path, not a name; recover the name for the picker. */
function guessWhisperModel(config: AlexandriaConfig): string {
  const match = /ggml-([\w.-]+)\.bin$/.exec(config.stt.modelPath ?? '');
  return match?.[1] ?? 'small';
}
