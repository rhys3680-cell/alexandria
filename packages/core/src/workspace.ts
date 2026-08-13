import fs from 'node:fs';
import path from 'node:path';

/** Path relative to the workspace root, mapped to its last-modified time. */
export type WorkspaceSnapshot = Map<string, number>;

export interface WorkspaceChanges {
  added: string[];
  modified: string[];
}

/** Files that are never interesting to report back. */
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

export function ensureWorkspace(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A snapshot taken before handing the model write access, so the app can say
 * exactly what it touched afterwards.
 *
 * Telling the user which files changed is the point: granting a model write
 * access and then leaving the result invisible is how a workspace becomes
 * something nobody trusts.
 */
export function snapshotWorkspace(dir: string, limit = 5000): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  if (!fs.existsSync(dir)) return snapshot;

  const walk = (current: string, depth: number): void => {
    if (depth > 8 || snapshot.size >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          snapshot.set(relative(dir, full), fs.statSync(full).mtimeMs);
        } catch {
          // A file that vanished mid-walk is simply not in the snapshot.
        }
      }
    }
  };

  walk(dir, 0);
  return snapshot;
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChanges {
  const added: string[] = [];
  const modified: string[] = [];

  for (const [file, mtime] of after) {
    const previous = before.get(file);
    if (previous === undefined) added.push(file);
    else if (previous !== mtime) modified.push(file);
  }
  // Deletions are deliberately not reported: the model is not asked to delete,
  // and surfacing a removal it did not make would be misleading.
  return { added: added.sort(), modified: modified.sort() };
}

function relative(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}
