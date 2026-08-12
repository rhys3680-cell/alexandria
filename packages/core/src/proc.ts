import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

/** Spawns a process, feeds it `input` on stdin, and buffers its output. */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
          // Escalate if it ignores the polite request.
          setTimeout(() => child.kill('SIGKILL'), 3000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });

    // Always close stdin. The claude CLI waits on it otherwise, and warns
    // after a few seconds when nothing arrives.
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export async function runOrThrow(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(file, args, options);
  if (result.timedOut) {
    throw new ProcessError(`${path.basename(file)} 실행이 시간 초과되었습니다.`, result);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 500);
    throw new ProcessError(`${path.basename(file)} 실행 실패 (exit ${result.code}): ${detail}`, result);
  }
  return result;
}

export interface ResolvedCommand {
  file: string;
  /** Args that must precede the caller's own, e.g. a script path for `node`. */
  prefixArgs: string[];
}

const resolveCache = new Map<string, ResolvedCommand | null>();

/**
 * Finds a real, directly spawnable executable for `command`.
 *
 * On Windows the npm shims are `.cmd`/`.ps1` files, which Node refuses to spawn
 * without `shell: true` — and a shell would mangle the JSON we pass in argv. So
 * we look past the shim for the `.exe` or the JS entry point it delegates to.
 */
export function resolveCommand(command: string): ResolvedCommand | null {
  const cached = resolveCache.get(command);
  if (cached !== undefined) return cached;
  const resolved = resolveUncached(command);
  resolveCache.set(command, resolved);
  return resolved;
}

function resolveUncached(command: string): ResolvedCommand | null {
  if (command.endsWith('.js') || command.endsWith('.mjs')) {
    return fs.existsSync(command) ? { file: process.execPath, prefixArgs: [command] } : null;
  }
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')) {
    return fs.existsSync(command) ? { file: command, prefixArgs: [] } : null;
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const shims: string[] = [];

  // On Windows an extension-less entry is typically a POSIX shell script left
  // by npm, which Node cannot spawn — only real binaries qualify as direct hits.
  const directExtensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];

  for (const dir of dirs) {
    // Prefer a real binary, which needs no shell and no shim parsing.
    for (const ext of directExtensions) {
      const candidate = path.join(dir, command + ext);
      if (isExecutableFile(candidate)) return { file: candidate, prefixArgs: [] };
    }
    for (const ext of ['.cmd', '.bat', '.ps1']) {
      const candidate = path.join(dir, command + ext);
      if (isExecutableFile(candidate)) shims.push(candidate);
    }
  }

  for (const shim of shims) {
    const target = resolveShimTarget(shim);
    if (target) return target;
  }
  return null;
}

/**
 * npm shims sit next to the package they launch. Rather than parse batch
 * syntax, we look for the package's own binary or JS entry point beside it.
 */
function resolveShimTarget(shim: string): ResolvedCommand | null {
  const dir = path.dirname(shim);
  const name = path.basename(shim, path.extname(shim));

  let contents = '';
  try {
    contents = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }

  // Pull referenced paths straight out of the shim and test them.
  const referenced = contents.match(/[\w@.\\/$%~-]*node_modules[\w@.\\/-]*/g) ?? [];
  for (const raw of referenced) {
    const cleaned = raw.replace(/^%dp0%\\?/i, '').replace(/^\$basedir\//, '');
    const candidate = path.resolve(dir, cleaned);
    if (isExecutableFile(candidate)) {
      return candidate.endsWith('.js') || candidate.endsWith('.mjs')
        ? { file: process.execPath, prefixArgs: [candidate] }
        : { file: candidate, prefixArgs: [] };
    }
  }

  for (const relative of [
    path.join('node_modules', '.bin', `${name}.exe`),
    path.join('node_modules', name, 'bin', `${name}.exe`),
  ]) {
    const candidate = path.join(dir, relative);
    if (isExecutableFile(candidate)) return { file: candidate, prefixArgs: [] };
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
