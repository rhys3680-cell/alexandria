import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveCommand } from './proc.js';

export interface SpeakOptions {
  /** BCP-47 primary subtag. Picks a matching installed voice when there is one. */
  language?: string;
}

export interface Speaker {
  readonly name: string;
  /** Null when ready, otherwise why it cannot speak. */
  check(): Promise<string | null>;
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): void;
}

/** Long answers are read aloud only up to here; past that it is a wall of speech. */
export const MAX_SPOKEN_CHARS = 2000;

const CULTURES: Record<string, string> = {
  ko: 'ko-KR',
  ja: 'ja-JP',
  zh: 'zh-CN',
  en: 'en-US',
};

/**
 * Speaks through Windows' built-in SAPI voices.
 *
 * Chromium's speechSynthesis was the obvious choice and does not work here:
 * measured in this Electron build it reports `supported: true` with zero
 * voices. SAPI is already on the machine, costs nothing, and stays local.
 */
export class WindowsSapiSpeaker implements Speaker {
  readonly name = 'windows-sapi';
  private current: ChildProcess | undefined;

  async check(): Promise<string | null> {
    if (process.platform !== 'win32') {
      return '이 플랫폼에서는 음성 출력을 지원하지 않습니다 (현재 Windows SAPI 만 구현).';
    }
    return resolveShell() ? null : 'PowerShell 을 찾을 수 없습니다.';
  }

  speak(text: string, options: SpeakOptions = {}): Promise<void> {
    const spoken = text.trim().slice(0, MAX_SPOKEN_CHARS);
    if (!spoken) return Promise.resolve();

    const shell = resolveShell();
    if (!shell) return Promise.reject(new Error('PowerShell 을 찾을 수 없습니다.'));

    this.stop();

    // The text goes through a file rather than the command line: an answer can
    // contain quotes, newlines and anything else that would break quoting.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-tts-'));
    const textFile = path.join(dir, `${randomBytes(4).toString('hex')}.txt`);
    const scriptFile = path.join(dir, 'speak.ps1');
    fs.writeFileSync(textFile, spoken, 'utf8');
    fs.writeFileSync(scriptFile, buildScript(textFile, CULTURES[options.language ?? ''] ?? ''), 'utf8');

    return new Promise((resolve, reject) => {
      const child = spawn(
        shell.file,
        [...shell.prefixArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        { windowsHide: true },
      );
      this.current = child;

      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const cleanup = () => {
        if (this.current === child) this.current = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
      };

      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('close', (code) => {
        cleanup();
        // A stop() kill is a normal outcome, not a failure.
        if (code === 0 || code === null) resolve();
        else reject(new Error(`음성 출력 실패: ${stderr.trim().slice(0, 200)}`));
      });
    });
  }

  stop(): void {
    this.current?.kill();
    this.current = undefined;
  }
}

/** Reads the text aloud, preferring a voice that matches the content's language. */
function buildScript(textFile: string, culture: string): string {
  const selectVoice = culture
    ? `$match = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq '${culture}' } | Select-Object -First 1
if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }`
    : '';

  return `Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${selectVoice}
$text = Get-Content -Raw -Encoding UTF8 -LiteralPath '${textFile.replace(/'/g, "''")}'
$synth.Speak($text)
$synth.Dispose()
`;
}

function resolveShell() {
  if (process.platform === 'win32') {
    const system32 = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (fs.existsSync(system32)) return { file: system32, prefixArgs: [] as string[] };
  }
  return resolveCommand('powershell');
}

/** Detects the script well enough to pick a voice; not a real language detector. */
export function guessLanguage(text: string): string {
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return 'ko';
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return 'en';
}
