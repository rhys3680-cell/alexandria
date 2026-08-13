import fs from 'node:fs';
import path from 'node:path';
import type { Alexandria } from '@alexandria/core';

export interface Candidate {
  file: string;
  bytes: number;
  kind: 'text' | 'audio';
}

export interface ImportPlan {
  candidates: Candidate[];
  skipped: number;
  /** Text files left behind for being under the size floor. */
  tooSmall: number;
  totalBytes: number;
  audioBytes: number;
  audioCount: number;
  textCount: number;
}

/** Directories that never hold anything worth taking in. */
const IGNORED = new Set(['node_modules', '.git', '.alexandria', 'items', 'media', '$RECYCLE.BIN']);

export interface PlanOptions {
  /** Text files smaller than this are left behind. */
  minTextBytes?: number;
  maxDepth?: number;
}

export function planImport(alx: Alexandria, roots: string[], options: PlanOptions = {}): ImportPlan {
  const { minTextBytes = 0, maxDepth = 12 } = options;
  const textExtensions = new Set(alx.config.ingest.textExtensions);
  const audioExtensions = new Set(alx.config.ingest.audioExtensions);
  const vaultRoot = path.resolve(alx.config.vaultDir);

  const candidates: Candidate[] = [];
  let skipped = 0;
  let tooSmall = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directories are reported by their absence, not a crash.
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
        // Never pull the vault into itself.
        if (path.resolve(full).startsWith(vaultRoot)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      const kind = textExtensions.has(extension) ? 'text' : audioExtensions.has(extension) ? 'audio' : undefined;
      if (!kind) continue;

      // A second run over the same folder must not duplicate everything.
      if (alx.alreadyImported(full)) {
        skipped++;
        continue;
      }
      try {
        const bytes = fs.statSync(full).size;
        // An export full of title-only stubs would otherwise cost real money to
        // organize into nothing.
        if (kind === 'text' && bytes < minTextBytes) {
          tooSmall++;
          continue;
        }
        candidates.push({ file: full, bytes, kind });
      } catch {
        // Vanished between listing and stat; nothing to import.
      }
    }
  };

  for (const root of roots) walk(path.resolve(root), 0);

  const audio = candidates.filter((candidate) => candidate.kind === 'audio');
  return {
    candidates,
    skipped,
    tooSmall,
    totalBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    audioBytes: audio.reduce((sum, candidate) => sum + candidate.bytes, 0),
    audioCount: audio.length,
    textCount: candidates.length - audio.length,
  };
}

export interface Estimate {
  costUsd: number;
  transcribeMinutes: number;
  vaultGrowthBytes: number;
}

/**
 * What this import will actually cost, before it starts.
 *
 * The numbers come from what this project measured: roughly $0.012 per
 * organize call, and whisper `small` running at about 2.1x realtime. Audio
 * minutes are guessed from file size, which is crude but enough to tell an
 * afternoon apart from a coffee break.
 */
export function estimate(plan: ImportPlan): Estimate {
  const COST_PER_ITEM = 0.012;
  const REALTIME_FACTOR = 2.1;
  // ~1 MB per minute covers both compressed speech and light video.
  const MINUTES_PER_MB = 1;

  const audioMinutes = (plan.audioBytes / (1024 * 1024)) * MINUTES_PER_MB;
  return {
    costUsd: plan.candidates.length * COST_PER_ITEM,
    transcribeMinutes: audioMinutes * REALTIME_FACTOR,
    // Audio is copied into the vault; text is small enough to ignore.
    vaultGrowthBytes: plan.audioBytes,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `약 ${Math.round(minutes)}분`;
  return `약 ${(minutes / 60).toFixed(1)}시간`;
}
