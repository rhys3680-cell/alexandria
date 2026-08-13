import type {
  AskResult,
  Briefing,
  Item,
  ListOptions,
  PipelineEvent,
  RelatedHit,
  SearchHit,
  ToolAccess,
} from '@alexandria/core';

export interface AskRequest {
  /** Correlates streamed chunks with this turn. */
  id: string;
  prompt: string;
  tools: ToolAccess;
  /** Vault items to place in front of the model. */
  contextIds?: string[];
  /** Session id from the previous answer, to continue the conversation. */
  resume?: string;
}

export interface AskChunk {
  id: string;
  text: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface VaultStats {
  byStatus: Record<string, number>;
  pending: number;
  totalCostUsd: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
  /** Command that fixes it, when there is one. */
  fix?: string;
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

  /** Past records connected to this one, with the reason for each link. */
  related(id: string, limit?: number): Promise<RelatedHit[]>;

  /**
   * The in-app browser lives above the renderer, so the React side reports
   * where its viewport should sit and the main process draws it there.
   */
  browserAttach(bounds: BrowserBounds): Promise<void>;
  browserDetach(): Promise<void>;
  browserNavigate(input: string): Promise<void>;
  browserBack(): Promise<void>;
  browserForward(): Promise<void>;
  browserReload(): Promise<void>;
  /** Captures the rendered page into the vault and returns the new item. */
  browserCapture(): Promise<Item>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;

  /** Transcribes a spoken question. Does not create a vault item. */
  transcribeVoice(buffer: ArrayBuffer, extension: string): Promise<string>;
  /** Reads text aloud through the system voice. */
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;

  /** Sends a turn to the model. Text arrives through `onAskChunk` meanwhile. */
  ask(request: AskRequest): Promise<AskResult>;
  saveAnswer(question: string, answer: string): Promise<Item>;
  /** Returns an unsubscribe function. */
  onAskChunk(listener: (chunk: AskChunk) => void): () => void;

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
  related: 'items:related',
  browserAttach: 'browser:attach',
  browserDetach: 'browser:detach',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserCapture: 'browser:capture',
  browserState: 'browser:state',
  transcribeVoice: 'voice:transcribe',
  speak: 'tts:speak',
  stopSpeaking: 'tts:stop',
  ask: 'ask:send',
  askChunk: 'ask:chunk',
  saveAnswer: 'ask:save',
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
