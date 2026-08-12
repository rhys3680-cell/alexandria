import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { resolveCommand, run, type ResolvedCommand } from '../proc.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo'] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

/** Rough on-disk size, so `alx setup` can warn before a long download. */
export const MODEL_SIZES: Record<WhisperModel, string> = {
  tiny: '~75 MB',
  base: '~142 MB',
  small: '~466 MB',
  medium: '~1.5 GB',
  'large-v3-turbo': '~1.6 GB',
};

/**
 * Measured on a 20-second Korean memo, against a known transcript.
 *
 * `base` transcribed English word for word but made six errors in Korean,
 * including the speaker's name and the product name — and a wrong name flows
 * straight into the item's `people` field, where nothing downstream can catch
 * it. `small` fixed both at roughly 2.4x the runtime, which is why it is the
 * default: wrong data is worse than slow data.
 */
export const MODEL_NOTES: Partial<Record<WhisperModel, string>> = {
  tiny: '가장 빠름 · 비영어권에는 권장하지 않음',
  base: '영어 전용이면 충분 · 한국어 고유명사에서 오류',
  small: '기본값 · 한국어 고유명사 정확, base 대비 약 2.4배 느림',
  medium: '더 정확하지만 상당히 느림',
  'large-v3-turbo': '최상 정확도 · 미측정',
};

export const DEFAULT_WHISPER_MODEL: WhisperModel = 'small';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const RELEASES_URL = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';

export interface DownloadProgress {
  (received: number, total: number | undefined): void;
}

export function modelFileName(model: WhisperModel): string {
  return `ggml-${model}.bin`;
}

export async function downloadFile(url: string, destination: string, onProgress?: DownloadProgress): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'alexandria' } });
  if (!response.ok || !response.body) {
    throw new Error(`다운로드 실패 (${response.status}): ${url}`);
  }

  const total = Number(response.headers.get('content-length')) || undefined;
  let received = 0;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });

  await streamPipeline(body, fs.createWriteStream(temporary));
  fs.renameSync(temporary, destination);
}

/** Downloads the ggml model unless it is already on disk. Returns its path. */
export async function ensureModel(
  vendorDir: string,
  model: WhisperModel,
  onProgress?: DownloadProgress,
): Promise<string> {
  const destination = path.join(vendorDir, 'models', modelFileName(model));
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;
  await downloadFile(`${MODEL_BASE_URL}/${modelFileName(model)}`, destination, onProgress);
  return destination;
}

export interface BinaryResult {
  path: string;
  /** Set when we could not install automatically; tells the user what to do. */
  instructions?: string;
}

/**
 * Installs a `whisper-cli` binary into the vault's vendor directory.
 *
 * Only Windows x64 has a usable prebuilt release asset; elsewhere we return
 * instructions rather than pretending to have installed something.
 */
export async function ensureWhisperBinary(vendorDir: string, onProgress?: DownloadProgress): Promise<BinaryResult> {
  const binDir = path.join(vendorDir, 'whisper');
  const existing = findWhisperBinary(binDir);
  if (existing) return { path: existing };

  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return {
      path: '',
      instructions: [
        '이 플랫폼용 whisper.cpp 프리빌트 바이너리는 제공되지 않습니다. 직접 빌드하세요:',
        '  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release',
        '그런 다음 빌드된 whisper-cli 경로를 설정하세요:',
        '  alx config set stt.binPath <경로>',
      ].join('\n'),
    };
  }

  const asset = await findWindowsAsset();
  if (!asset) {
    return {
      path: '',
      instructions:
        'whisper.cpp 릴리스에서 Windows 바이너리를 찾지 못했습니다. https://github.com/ggml-org/whisper.cpp/releases 에서 직접 받아 `alx config set stt.binPath <경로>` 로 지정하세요.',
    };
  }

  const archive = path.join(binDir, path.basename(asset.name));
  // A previous run may have downloaded it and failed only at extraction.
  if (!fs.existsSync(archive)) await downloadFile(asset.url, archive, onProgress);

  const tar = resolveArchiver();
  if (!tar) {
    return { path: '', instructions: `압축을 풀 수 없습니다. 직접 해제하세요: ${archive}` };
  }
  const extracted = await run(tar.file, [...tar.prefixArgs, '-xf', archive, '-C', binDir], {
    timeoutMs: 5 * 60 * 1000,
  });
  if (extracted.code !== 0) {
    return { path: '', instructions: `압축 해제에 실패했습니다: ${extracted.stderr.slice(0, 300)}` };
  }
  fs.rmSync(archive, { force: true });

  const installed = findWhisperBinary(binDir);
  if (!installed) {
    return { path: '', instructions: `압축은 풀렸지만 whisper-cli 실행 파일을 찾지 못했습니다: ${binDir}` };
  }
  return { path: installed };
}

/**
 * Windows ships bsdtar at System32, which reads zip archives and understands
 * drive letters. It must be addressed by full path rather than through PATH:
 * inside a Git Bash environment `tar` resolves to GNU tar, which reads `C:\...`
 * as a remote host ("Cannot connect to C") and cannot open a zip at all.
 */
function resolveArchiver(): ResolvedCommand | null {
  if (process.platform === 'win32') {
    const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(bsdtar)) return { file: bsdtar, prefixArgs: [] };
  }
  return resolveCommand('tar');
}

async function findWindowsAsset(): Promise<{ name: string; url: string } | undefined> {
  const response = await fetch(RELEASES_URL, {
    headers: { 'user-agent': 'alexandria', accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return undefined;

  const release = (await response.json()) as { assets?: { name?: string; browser_download_url?: string }[] };
  const assets = release.assets ?? [];
  // Prefer the plain CPU build: GPU-specific archives need extra runtimes.
  const preferred = [/^whisper-bin-x64\.zip$/i, /^whisper-bin-Win32\.zip$/i, /whisper.*x64.*\.zip$/i];

  for (const pattern of preferred) {
    const match = assets.find((asset) => asset.name && pattern.test(asset.name));
    if (match?.name && match.browser_download_url) {
      return { name: match.name, url: match.browser_download_url };
    }
  }
  return undefined;
}

/** Recent releases ship `whisper-cli`; older ones called it `main`. */
export function findWhisperBinary(root: string): string | undefined {
  const names =
    process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];

  // One full pass per name, so preference order beats directory order. Current
  // releases ship both binaries side by side and `main` sorts first, which is
  // exactly the case a single pass would get wrong.
  for (const name of names) {
    const found = findFileNamed(root, name, 0);
    if (found) return found;
  }
  return undefined;
}

function findFileNamed(dir: string, name: string, depth: number): string | undefined {
  if (depth > 4 || !fs.existsSync(dir)) return undefined;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findFileNamed(path.join(dir, entry.name), name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
