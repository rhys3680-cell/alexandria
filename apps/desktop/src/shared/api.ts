import type { Briefing, Item, ListOptions, PipelineEvent, SearchHit } from '@alexandria/core';

export interface VaultStats {
  byStatus: Record<string, number>;
  pending: number;
  totalCostUsd: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The entire surface the renderer is allowed to touch. */
export interface AlexandriaApi {
  captureText(text: string): Promise<Item>;
  /** Raw bytes from MediaRecorder; the main process owns the filesystem. */
  captureAudio(buffer: ArrayBuffer, extension: string): Promise<Item>;
  captureFiles(paths: string[]): Promise<Item[]>;
  /** Resolves a dropped `File` to its real path; `File.path` no longer exists. */
  pathForFile(file: File): string;

  list(options?: ListOptions): Promise<Item[]>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  get(id: string): Promise<Item | undefined>;
  remove(id: string): Promise<boolean>;

  /** The "먼저 보여주기" view: what needs attention today. */
  briefing(soonDays?: number): Promise<Briefing>;
  setTaskDone(itemId: string, index: number, done: boolean): Promise<Item | undefined>;

  stats(): Promise<VaultStats>;
  doctor(): Promise<DoctorCheck[]>;
  vaultPath(): Promise<string>;
  revealVault(): Promise<void>;

  /** Nudges the background worker; it also runs on its own. */
  processNow(): Promise<void>;

  /** Returns an unsubscribe function. */
  onPipelineEvent(listener: (event: PipelineEvent) => void): () => void;
  /** Fired whenever the item set changed and lists should refetch. */
  onChanged(listener: () => void): () => void;
}

export const IPC = {
  captureText: 'capture:text',
  captureAudio: 'capture:audio',
  captureFiles: 'capture:files',
  list: 'items:list',
  search: 'items:search',
  get: 'items:get',
  remove: 'items:remove',
  briefing: 'vault:briefing',
  setTaskDone: 'items:task-done',
  stats: 'vault:stats',
  doctor: 'vault:doctor',
  vaultPath: 'vault:path',
  revealVault: 'vault:reveal',
  processNow: 'queue:process',
  pipelineEvent: 'queue:event',
  changed: 'items:changed',
} as const;
