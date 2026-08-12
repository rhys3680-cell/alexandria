import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SttConfig } from '../config.js';
import { resolveCommand, run } from '../proc.js';
import type { TranscriptionResult, TranscriptSegment } from '../types.js';

export interface Transcriber {
  readonly name: string;
  check(): Promise<string | null>;
  transcribe(audioPath: string): Promise<TranscriptionResult>;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: {
    text?: string;
    offsets?: { from?: number; to?: number };
  }[];
}

/**
 * Runs whisper.cpp's `whisper-cli` as a child process.
 *
 * Spawning a binary rather than binding a native module means the desktop app
 * has zero native dependencies to rebuild for Electron, and the exact same code
 * path serves the CLI.
 */
export class WhisperCppTranscriber implements Transcriber {
  readonly name = 'whisper.cpp';

  constructor(private readonly config: SttConfig) {}

  async check(): Promise<string | null> {
    if (!this.config.binPath || !fs.existsSync(this.config.binPath)) {
      return 'whisper-cli 실행 파일이 설정되지 않았습니다. `alx setup whisper` 를 실행하세요.';
    }
    if (!this.config.modelPath || !fs.existsSync(this.config.modelPath)) {
      return 'whisper 모델 파일이 없습니다. `alx setup whisper` 를 실행하세요.';
    }
    if (!resolveCommand(this.config.ffmpegPath)) {
      return `ffmpeg 를 찾을 수 없습니다 ('${this.config.ffmpegPath}'). 오디오 변환에 필요합니다.`;
    }
    return null;
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    const problem = await this.check();
    if (problem) throw new TranscriptionError(problem);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-stt-'));
    const wavPath = path.join(workDir, 'audio.wav');
    const outBase = path.join(workDir, 'out');

    try {
      await this.toWav(audioPath, wavPath);

      const whisper = resolveCommand(this.config.binPath!);
      if (!whisper) throw new TranscriptionError(`whisper-cli 를 실행할 수 없습니다: ${this.config.binPath}`);

      const args = [
        ...whisper.prefixArgs,
        '-m',
        this.config.modelPath!,
        '-f',
        wavPath,
        '--output-json',
        '--output-file',
        outBase,
        '--no-prints',
      ];
      if (this.config.language && this.config.language !== 'auto') {
        args.push('-l', this.config.language);
      } else {
        // Auto-detect: the whole point of a multilingual vault.
        args.push('-l', 'auto');
      }
      if (this.config.threads) args.push('-t', String(this.config.threads));

      const result = await run(whisper.file, args, { timeoutMs: 60 * 60 * 1000 });
      if (result.code !== 0) {
        throw new TranscriptionError('음성 인식에 실패했습니다.', (result.stderr || result.stdout).slice(0, 800));
      }

      const jsonPath = `${outBase}.json`;
      if (!fs.existsSync(jsonPath)) {
        throw new TranscriptionError('whisper 가 결과 파일을 만들지 않았습니다.', result.stderr.slice(0, 800));
      }

      return parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** whisper.cpp only accepts 16 kHz mono PCM WAV, so everything goes through ffmpeg. */
  private async toWav(input: string, output: string): Promise<void> {
    const ffmpeg = resolveCommand(this.config.ffmpegPath);
    if (!ffmpeg) throw new TranscriptionError(`ffmpeg 를 찾을 수 없습니다: ${this.config.ffmpegPath}`);

    const result = await run(
      ffmpeg.file,
      [...ffmpeg.prefixArgs, '-nostdin', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output],
      { timeoutMs: 10 * 60 * 1000 },
    );
    if (result.code !== 0) {
      throw new TranscriptionError('오디오 변환에 실패했습니다.', result.stderr.slice(-800));
    }
  }
}

export function parseWhisperJson(raw: string): TranscriptionResult {
  let parsed: WhisperJson;
  try {
    parsed = JSON.parse(raw) as WhisperJson;
  } catch {
    throw new TranscriptionError('whisper 결과 JSON 을 해석할 수 없습니다.');
  }

  const segments: TranscriptSegment[] = [];
  for (const entry of parsed.transcription ?? []) {
    const text = (entry.text ?? '').trim();
    if (!text) continue;
    segments.push({
      start: Number(entry.offsets?.from ?? 0),
      end: Number(entry.offsets?.to ?? 0),
      text,
    });
  }

  const language = parsed.result?.language;
  return {
    text: segments.map((segment) => segment.text).join(' ').trim(),
    language: language && language !== 'auto' ? language : undefined,
    durationMs: segments.length ? segments[segments.length - 1]!.end : 0,
    segments,
  };
}

/** Transcript rendered as markdown with timestamps, used as the item body. */
export function formatTranscript(result: TranscriptionResult): string {
  if (!result.segments.length) return result.text;
  return result.segments
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
    .join('\n');
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function randomTempName(extension: string): string {
  return `${randomBytes(6).toString('hex')}${extension}`;
}
