import fs from 'node:fs';
import path from 'node:path';
import { buildBriefing, type Briefing, type BriefingOptions } from './briefing.js';
import { loadConfig, vendorDir, type AlexandriaConfig } from './config.js';
import { openDatabase, type Database } from './db.js';
import { newId } from './ids.js';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  pendingJobCount,
  requeueStuckJobs,
  type Job,
} from './jobs.js';
import type { SearchHit } from './store.js';
import { ClaudeCliAdapter } from './llm/claude-cli.js';
import { organize } from './llm/organizer.js';
import type { LlmAdapter } from './llm/adapter.js';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { embeddingText, TransformersEmbedder, type Embedder } from './search/embedder.js';
import { fuseRanks, rankBySimilarity, significantNeighbours } from './search/hybrid.js';
import { formatTranscript, WhisperCppTranscriber, type Transcriber } from './stt/whisper.js';
import * as store from './store.js';
import type { Item, ItemSource, ItemTask } from './types.js';
import { Vault } from './vault.js';

export interface CaptureTextInput {
  text: string;
  source?: ItemSource;
  sourceRef?: string;
  createdAt?: Date;
  /** Skips the organize pass; useful for imports that already carry metadata. */
  skipOrganize?: boolean;
}

export interface CaptureAudioInput {
  filePath: string;
  source?: ItemSource;
  sourceRef?: string;
  createdAt?: Date;
  /** Move instead of copy, for recordings the app itself produced. */
  move?: boolean;
}

export type PipelineEvent =
  | { type: 'job:start'; job: Job; item: Item }
  | { type: 'job:done'; job: Job; item: Item; costUsd: number }
  | { type: 'job:error'; job: Job; itemId: string; error: string; willRetry: boolean };

export interface ProcessSummary {
  processed: number;
  failed: number;
  costUsd: number;
}

export interface AlexandriaDeps {
  config?: AlexandriaConfig;
  llm?: LlmAdapter;
  transcriber?: Transcriber;
  embedder?: Embedder;
  logger?: Logger;
  db?: Database;
}

export type SearchMode = 'auto' | 'lexical' | 'semantic';

export interface RelatedHit {
  item: Item;
  score: number;
  /** Which signal connected the two items. */
  via: 'shared' | 'semantic' | 'both';
  /** Tags, keywords or people both items carry. Empty for a purely semantic link. */
  shared: string[];
}

/**
 * The whole pipeline, usable from anywhere: the CLI drives it directly, the
 * Electron main process holds one instance, and both see the same vault.
 */
export class Alexandria {
  readonly config: AlexandriaConfig;
  readonly vault: Vault;
  readonly db: Database;
  readonly llm: LlmAdapter;
  readonly transcriber: Transcriber;
  readonly embedder: Embedder;
  private readonly logger: Logger;

  constructor(deps: AlexandriaDeps = {}) {
    this.config = deps.config ?? loadConfig();
    this.vault = new Vault(this.config.vaultDir);
    this.vault.ensure();
    this.db = deps.db ?? openDatabase(this.config.vaultDir);
    this.llm = deps.llm ?? new ClaudeCliAdapter(this.config.llm);
    this.transcriber = deps.transcriber ?? new WhisperCppTranscriber(this.config.stt);
    this.embedder =
      deps.embedder ?? new TransformersEmbedder(this.config.search, vendorDir(this.config.vaultDir));
    this.logger = deps.logger ?? silentLogger;

    // Anything left mid-flight by a crash goes back in the queue.
    const requeued = requeueStuckJobs(this.db);
    if (requeued > 0) this.logger.info(`중단된 작업 ${requeued}건을 다시 대기열에 넣었습니다.`);
  }

  static open(vaultDir?: string, deps: AlexandriaDeps = {}): Alexandria {
    return new Alexandria({ ...deps, config: deps.config ?? loadConfig(vaultDir) });
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- capture

  captureText(input: CaptureTextInput): Item {
    const text = input.text.trim();
    if (!text) throw new Error('빈 내용은 저장할 수 없습니다.');

    const now = input.createdAt ?? new Date();
    const item = this.blankItem(now, input.source ?? 'manual', input.sourceRef);
    const written = this.vault.writeItem({ ...item, body: text, status: 'transcribed' });

    store.upsertItem(this.db, written);
    if (!input.skipOrganize) enqueueJob(this.db, written.id, 'organize');
    this.logger.info('캡처', { id: written.id, chars: text.length });
    return written;
  }

  captureAudio(input: CaptureAudioInput): Item {
    if (!fs.existsSync(input.filePath)) {
      throw new Error(`파일을 찾을 수 없습니다: ${input.filePath}`);
    }

    const now = input.createdAt ?? new Date();
    const base = this.blankItem(now, input.source ?? 'mic', input.sourceRef ?? input.filePath);

    const mediaRelative = this.vault.mediaPathFor(base.id, path.extname(input.filePath) || '.wav');
    const mediaAbsolute = this.vault.absolute(mediaRelative);
    fs.mkdirSync(path.dirname(mediaAbsolute), { recursive: true });
    if (input.move) fs.renameSync(input.filePath, mediaAbsolute);
    else fs.copyFileSync(input.filePath, mediaAbsolute);

    const written = this.vault.writeItem({ ...base, media: mediaRelative, status: 'raw' });
    store.upsertItem(this.db, written);
    enqueueJob(this.db, written.id, 'transcribe');
    this.logger.info('오디오 캡처', { id: written.id, media: mediaRelative });
    return written;
  }

  /** Dispatches a dropped or watched file by extension. */
  captureFile(filePath: string, source: ItemSource = 'file'): Item {
    const extension = path.extname(filePath).toLowerCase();
    if (this.config.ingest.audioExtensions.includes(extension)) {
      return this.captureAudio({ filePath, source, sourceRef: filePath });
    }
    if (this.config.ingest.textExtensions.includes(extension)) {
      return this.captureText({
        text: fs.readFileSync(filePath, 'utf8'),
        source,
        sourceRef: filePath,
      });
    }
    throw new Error(`지원하지 않는 파일 형식입니다: ${extension || filePath}`);
  }

  // ---------------------------------------------------------------- process

  pendingCount(): number {
    return pendingJobCount(this.db);
  }

  /** Runs one queued job. Returns false when the queue is empty. */
  async processNext(onEvent?: (event: PipelineEvent) => void): Promise<boolean> {
    const job = claimNextJob(this.db);
    if (!job) return false;

    const item = store.getItem(this.db, job.itemId);
    if (!item) {
      // The file was deleted underneath us; drop the job rather than retry.
      completeJob(this.db, job.id);
      return true;
    }

    onEvent?.({ type: 'job:start', job, item });

    try {
      const { item: updated, costUsd } = await this.runJob(job.type, item);
      completeJob(this.db, job.id);
      onEvent?.({ type: 'job:done', job, item: updated, costUsd });
    } catch (error) {
      const message = describeError(error);
      const state = failJob(this.db, job.id, message);
      const willRetry = state === 'pending';

      if (!willRetry) {
        const failed = this.vault.writeItem({ ...item, status: 'failed', error: message, updated: nowIso() });
        store.upsertItem(this.db, failed);
      }
      this.logger.warn('작업 실패', { id: item.id, type: job.type, willRetry, message });
      onEvent?.({ type: 'job:error', job, itemId: item.id, error: message, willRetry });
    }
    return true;
  }

  async processPending(
    options: { limit?: number; onEvent?: (event: PipelineEvent) => void } = {},
  ): Promise<ProcessSummary> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const summary: ProcessSummary = { processed: 0, failed: 0, costUsd: 0 };

    for (let count = 0; count < limit; count++) {
      const handled = await this.processNext((event) => {
        if (event.type === 'job:done') {
          summary.processed++;
          summary.costUsd += event.costUsd;
        }
        if (event.type === 'job:error' && !event.willRetry) summary.failed++;
        options.onEvent?.(event);
      });
      if (!handled) break;
    }
    return summary;
  }

  private runJob(type: Job['type'], item: Item): Promise<{ item: Item; costUsd: number }> {
    switch (type) {
      case 'transcribe':
        return this.runTranscribe(item);
      case 'organize':
        return this.runOrganize(item);
      case 'embed':
        return this.runEmbed(item);
    }
  }

  private async runEmbed(item: Item): Promise<{ item: Item; costUsd: number }> {
    const text = embeddingText(item, this.config.search.maxChars);
    if (!text.trim()) throw new Error('임베딩할 내용이 없습니다.');

    const [vector] = await this.embedder.embedPassages([text]);
    if (!vector) throw new Error('임베딩 결과가 비어 있습니다.');

    // Embedding is derived data only: the markdown file is untouched.
    store.upsertEmbedding(this.db, item.id, this.config.search.model, vector);
    return { item, costUsd: 0 };
  }

  private async runTranscribe(item: Item): Promise<{ item: Item; costUsd: number }> {
    if (!item.media) throw new Error('오디오 파일이 없는 항목입니다.');

    const working = this.vault.writeItem({ ...item, status: 'transcribing', updated: nowIso() });
    store.upsertItem(this.db, working);

    const result = await this.transcriber.transcribe(this.vault.absolute(item.media));
    if (!result.text.trim()) throw new Error('전사 결과가 비어 있습니다. 무음이거나 인식에 실패했습니다.');

    const transcribed = this.vault.writeItem({
      ...working,
      body: formatTranscript(result),
      lang: result.language ?? working.lang,
      durationMs: result.durationMs,
      status: 'transcribed',
      updated: nowIso(),
    });
    store.upsertItem(this.db, transcribed);
    enqueueJob(this.db, transcribed.id, 'organize');
    return { item: transcribed, costUsd: 0 };
  }

  private async runOrganize(item: Item): Promise<{ item: Item; costUsd: number }> {
    if (!item.body.trim()) throw new Error('정리할 내용이 없습니다.');

    const working = this.vault.writeItem({ ...item, status: 'organizing', updated: nowIso() });
    store.upsertItem(this.db, working);

    const outcome = await organize(this.llm, {
      body: working.body,
      capturedAt: working.created,
      source: working.source,
      sourceRef: working.sourceRef,
      languageHint: working.lang,
    });

    // The filename is derived from the title, which only exists now — so this
    // write renames the file.
    const organized = this.vault.writeItem(
      {
        ...working,
        lang: outcome.result.lang,
        kind: outcome.result.kind,
        title: outcome.result.title,
        summary: outcome.result.summary,
        tags: outcome.result.tags,
        keywords: outcome.result.keywords,
        people: outcome.result.people,
        tasks: outcome.result.tasks,
        highlights: outcome.result.highlights,
        status: 'organized',
        organizedAt: nowIso(),
        model: outcome.model,
        costUsd: round4((working.costUsd ?? 0) + outcome.costUsd),
        error: undefined,
        updated: nowIso(),
      },
      { rename: true },
    );

    store.upsertItem(this.db, organized);
    // Embedding runs as its own job so a model failure cannot undo the organize
    // work that was just paid for.
    if (this.config.search.semantic) enqueueJob(this.db, organized.id, 'embed');

    this.logger.info('정리 완료', { id: organized.id, title: organized.title, costUsd: outcome.costUsd });
    return { item: organized, costUsd: outcome.costUsd };
  }

  // ------------------------------------------------------------------ query

  get(id: string): Item | undefined {
    return store.getItem(this.db, id);
  }

  list(options: store.ListOptions = {}): Item[] {
    return store.listItems(this.db, options);
  }

  /**
   * Lexical and semantic results, fused by rank.
   *
   * Lexical alone misses anything phrased differently from the note; semantic
   * alone is unreliable for exact terms, names and identifiers. Running both
   * and fusing by position covers each one's blind spot, and the search
   * silently degrades to lexical whenever embeddings are unavailable.
   */
  async search(query: string, limit = 30, mode: SearchMode = 'auto'): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Over-fetch from each side so fusion has room to reorder.
    const pool = limit * 2;
    const lexical = mode === 'semantic' ? [] : store.searchItems(this.db, trimmed, pool);
    const lexicalOnly = () => lexical.slice(0, limit).map((hit) => ({ ...hit, via: 'lexical' as const }));

    if (mode === 'lexical' || !this.config.search.semantic) return lexicalOnly();

    const embeddings = store.loadEmbeddings(this.db, this.config.search.model);
    if (!embeddings.length) return lexicalOnly();

    let semantic: { id: string; score: number }[];
    try {
      semantic = rankBySimilarity(embeddings, await this.embedder.embedQuery(trimmed), pool);
    } catch (error) {
      this.logger.warn('의미 검색 실패, 어휘 검색으로 대체', { error: describeError(error) });
      return lexicalOnly();
    }

    const lexicalIds = lexical.map((hit) => hit.item.id);
    const semanticIds = semantic.map((entry) => entry.id);
    const inLexical = new Set(lexicalIds);
    const inSemantic = new Set(semanticIds);
    const snippets = new Map(lexical.map((hit) => [hit.item.id, hit.snippet]));

    const hits: SearchHit[] = [];
    for (const fused of fuseRanks([lexicalIds, semanticIds])) {
      if (hits.length >= limit) break;
      const item = store.getItem(this.db, fused.id);
      if (!item) continue;

      const both = inLexical.has(fused.id) && inSemantic.has(fused.id);
      hits.push({
        item,
        // Only the lexical index can point at the matching words; a semantic
        // hit falls back to the summary.
        snippet: snippets.get(fused.id) ?? item.summary ?? '',
        score: fused.score,
        via: both ? 'both' : inLexical.has(fused.id) ? 'lexical' : 'semantic',
      });
    }
    return hits;
  }

  /**
   * Past records connected to this one.
   *
   * Two independent signals, fused the same way search is: shared facets, which
   * are exact and explainable, and vector neighbours, which catch a connection
   * nobody thought to tag. Synchronous because the source item's vector is
   * already stored — nothing needs to be embedded at read time.
   */
  related(id: string, limit = 5): RelatedHit[] {
    const source = store.getItem(this.db, id);
    if (!source) return [];

    const pool = limit * 3;
    const facetMatches = store.relatedByFacets(this.db, source, pool);
    const sharedById = new Map(facetMatches.map((match) => [match.id, match.shared]));

    let semanticIds: string[] = [];
    if (this.config.search.semantic) {
      const embeddings = store.loadEmbeddings(this.db, this.config.search.model);
      const own = embeddings.find((entry) => entry.id === id);
      if (own) {
        // Only neighbours that stand out from this item's own baseline: a plain
        // top-N would return the whole vault and train the reader to ignore it.
        semanticIds = significantNeighbours(
          embeddings.filter((entry) => entry.id !== id),
          own.vector,
          pool,
        ).map((entry) => entry.id);
      }
    }

    const hits: RelatedHit[] = [];
    for (const fused of fuseRanks([facetMatches.map((match) => match.id), semanticIds])) {
      if (hits.length >= limit) break;
      const item = store.getItem(this.db, fused.id);
      if (!item) continue;

      const shared = sharedById.get(fused.id) ?? [];
      const bySemantic = semanticIds.includes(fused.id);
      hits.push({
        item,
        score: fused.score,
        shared,
        via: shared.length && bySemantic ? 'both' : shared.length ? 'shared' : 'semantic',
      });
    }
    return hits;
  }

  /** Queues embeddings for organized items that do not have one yet. */
  embedMissing(limit?: number): number {
    const missing = store.itemsMissingEmbedding(this.db, this.config.search.model, limit);
    for (const id of missing) enqueueJob(this.db, id, 'embed');
    return missing.length;
  }

  tags(limit?: number): { tag: string; count: number }[] {
    return store.allTags(this.db, limit);
  }

  briefing(options?: BriefingOptions): Briefing {
    return buildBriefing(this.db, options);
  }

  /**
   * Marks one of an item's tasks done. The markdown file is rewritten, so
   * completion survives a reindex like everything else.
   */
  setTaskDone(itemId: string, taskIndex: number, done: boolean): Item | undefined {
    const item = store.getItem(this.db, itemId);
    const target = item?.tasks[taskIndex];
    if (!item || !target) return undefined;

    const tasks = item.tasks.map((task, index) => {
      if (index !== taskIndex) return task;
      // Rebuilt rather than spread-with-undefined: undefined keys would reach
      // the YAML serialiser as explicit nulls.
      const next: ItemTask = { text: task.text };
      if (task.due) next.due = task.due;
      if (task.owner) next.owner = task.owner;
      if (done) {
        next.done = true;
        next.doneAt = nowIso();
      }
      return next;
    });

    const updated = this.vault.writeItem({ ...item, tasks, updated: nowIso() });
    store.upsertItem(this.db, updated);
    return updated;
  }

  stats(): {
    byStatus: Record<string, number>;
    pending: number;
    totalCostUsd: number;
    embedded: number;
    semantic: boolean;
  } {
    const row = this.db.prepare('select coalesce(sum(cost_usd), 0) as total from items').get() as
      | { total?: number }
      | undefined;
    return {
      byStatus: store.countByStatus(this.db),
      pending: pendingJobCount(this.db),
      totalCostUsd: round4(Number(row?.total ?? 0)),
      embedded: store.embeddingCount(this.db, this.config.search.model),
      semantic: this.config.search.semantic,
    };
  }

  delete(id: string): boolean {
    const item = store.getItem(this.db, id);
    if (!item) return false;
    this.vault.deleteItem(item);
    store.removeItem(this.db, id);
    return true;
  }

  /** Rebuilds the index from the markdown files, which are the source of truth. */
  reindex(onProgress?: (done: number, total: number) => void): number {
    const paths = this.vault.listItemPaths();
    this.db.exec('delete from items; delete from items_fts; delete from items_tri;');

    let indexed = 0;
    for (const relative of paths) {
      try {
        store.upsertItem(this.db, this.vault.readItem(relative));
        indexed++;
      } catch (error) {
        this.logger.warn('색인 실패', { path: relative, error: describeError(error) });
      }
      onProgress?.(indexed, paths.length);
    }
    return indexed;
  }

  async doctor(): Promise<{ name: string; ok: boolean; detail?: string }[]> {
    const llmProblem = await this.llm.check();
    const sttProblem = await this.transcriber.check();
    // Semantic search being off is a choice, not a fault, so it is not reported
    // as a failure — only a model that will not load is.
    const embedProblem = this.config.search.semantic ? await this.embedder.check() : null;

    return [
      { name: `LLM (${this.llm.name}, model=${this.config.llm.model})`, ok: !llmProblem, detail: llmProblem ?? undefined },
      { name: `STT (${this.transcriber.name})`, ok: !sttProblem, detail: sttProblem ?? undefined },
      {
        name: `의미 검색 (${this.config.search.model})`,
        ok: !embedProblem,
        detail: this.config.search.semantic
          ? embedProblem ?? `벡터 ${store.embeddingCount(this.db, this.config.search.model)}건`
          : '꺼짐 — `alx setup embeddings` 로 켤 수 있습니다',
      },
      { name: `Vault (${this.config.vaultDir})`, ok: fs.existsSync(this.config.vaultDir) },
    ];
  }

  private blankItem(created: Date, source: ItemSource, sourceRef?: string): Item {
    const iso = created.toISOString();
    return {
      id: newId(created),
      schema: 1,
      created: iso,
      updated: iso,
      source,
      sourceRef,
      status: 'raw',
      tags: [],
      keywords: [],
      people: [],
      tasks: [],
      highlights: [],
      body: '',
      path: '',
    };
  }
}

export function createLoggerForCli(verbose: boolean): Logger {
  return verbose ? createLogger('debug') : createLogger('warn');
}

function nowIso(): string {
  return new Date().toISOString();
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as { detail?: string }).detail;
    return detail ? `${error.message} — ${detail}` : error.message;
  }
  return String(error);
}
