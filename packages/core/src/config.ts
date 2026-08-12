import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface LlmConfig {
  /** Executable to spawn. `claude` today; a Codex adapter can slot in later. */
  command: string;
  /**
   * Model alias or full name. The CLI default is Opus, which is overkill for
   * summarising a note — `sonnet` is the better default here, `haiku` is cheaper still.
   */
  model: string;
  /**
   * Reasoning effort. Organizing is a shallow extraction task, and `low` halves
   * the output tokens — which dominate the cost — with no measurable quality
   * loss, so it is the default.
   */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Hard ceiling per call, passed through as `--max-budget-usd`. */
  maxBudgetUsd?: number;
  timeoutMs: number;
}

export interface SttConfig {
  /** Path to a whisper.cpp `whisper-cli` binary. */
  binPath?: string;
  /** Path to a ggml model file. */
  modelPath?: string;
  /** `auto` lets whisper detect the language, which is what we want for a multilingual vault. */
  language: string;
  threads?: number;
  ffmpegPath: string;
}

export interface IngestConfig {
  watchDirs: string[];
  textExtensions: string[];
  audioExtensions: string[];
}

export interface AlexandriaConfig {
  vaultDir: string;
  llm: LlmConfig;
  stt: SttConfig;
  ingest: IngestConfig;
}

export const CONFIG_DIRNAME = '.alexandria';

export function defaultVaultDir(): string {
  return process.env.ALEXANDRIA_VAULT ?? path.join(homedir(), 'Alexandria');
}

export function defaultConfig(vaultDir = defaultVaultDir()): AlexandriaConfig {
  return {
    vaultDir,
    llm: {
      command: process.env.ALEXANDRIA_LLM_COMMAND ?? 'claude',
      model: process.env.ALEXANDRIA_LLM_MODEL ?? 'sonnet',
      effort: 'low',
      timeoutMs: 120_000,
    },
    stt: {
      language: 'auto',
      ffmpegPath: process.env.ALEXANDRIA_FFMPEG ?? 'ffmpeg',
    },
    ingest: {
      watchDirs: [],
      textExtensions: ['.md', '.txt', '.markdown'],
      audioExtensions: ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.mp4'],
    },
  };
}

export function configPath(vaultDir: string): string {
  return path.join(vaultDir, CONFIG_DIRNAME, 'config.json');
}

export function loadConfig(vaultDir = defaultVaultDir()): AlexandriaConfig {
  const base = defaultConfig(vaultDir);
  const file = configPath(vaultDir);
  if (!fs.existsSync(file)) return base;

  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`설정 파일을 읽을 수 없습니다: ${file} (${(error as Error).message})`);
  }
  if (!stored || typeof stored !== 'object') return base;
  const partial = stored as Partial<AlexandriaConfig>;

  return {
    // The vault directory is decided by where we looked, not by the file itself,
    // so a moved vault keeps working.
    vaultDir,
    llm: { ...base.llm, ...partial.llm },
    stt: { ...base.stt, ...partial.stt },
    ingest: { ...base.ingest, ...partial.ingest },
  };
}

export function saveConfig(config: AlexandriaConfig): void {
  const file = configPath(config.vaultDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { vaultDir: _ignored, ...rest } = config;
  fs.writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`, 'utf8');
}
