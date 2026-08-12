import path from 'node:path';
import type { SearchConfig } from '../config.js';
import type { Item } from '../types.js';

export interface EmbedProgress {
  file: string;
  loaded?: number;
  total?: number;
}

/**
 * Measured on a 5-item / 10-query vault mixing Korean, Japanese and English.
 * The set is small, so read these as direction rather than proof — but the
 * ordering was consistent and the failures were all the same shape: a Korean
 * query failing to reach a non-Korean note.
 */
export const KNOWN_MODELS: Record<string, { dims: number; download: string; note: string }> = {
  'Xenova/multilingual-e5-small': { dims: 384, download: '~60 MB', note: 'rank1 4/10 · 가장 가벼움' },
  'Xenova/multilingual-e5-base': { dims: 768, download: '~110 MB', note: 'rank1 7/10 · 기본값' },
  'Xenova/bge-m3': { dims: 1024, download: '~570 MB', note: 'rank1 10/10 · 교차 언어 최상, 무거움' },
};

export interface Embedder {
  readonly model: string;
  /** Null when ready, otherwise a human-readable reason it cannot run. */
  check(): Promise<string | null>;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

/**
 * Local embeddings through transformers.js.
 *
 * The ONNX runtime it pulls in is a native module, but an N-API prebuilt:
 * verified to load unchanged in both Node 24 and Electron 43, so there is still
 * nothing to rebuild. transformers.js is imported dynamically so that a vault
 * with semantic search switched off never pays for loading it.
 */
export class TransformersEmbedder implements Embedder {
  readonly model: string;

  private extractor: ((text: string[], options: object) => Promise<{ tolist(): number[][] }>) | undefined;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly config: SearchConfig,
    private readonly cacheDir: string,
    private readonly onProgress?: (progress: EmbedProgress) => void,
  ) {
    this.model = config.model;
  }

  async check(): Promise<string | null> {
    if (!this.config.semantic) {
      return '의미 검색이 꺼져 있습니다. `alx setup embeddings` 로 켜세요.';
    }
    try {
      await this.load();
      return null;
    } catch (error) {
      return `임베딩 모델을 불러오지 못했습니다: ${(error as Error).message}`;
    }
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    return this.run(texts.map((text) => this.decorate(text, 'passage')));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.run([this.decorate(text, 'query')]);
    if (!vector) throw new Error('질의 임베딩에 실패했습니다.');
    return vector;
  }

  /**
   * e5 models are trained with these prefixes and lose real accuracy without
   * them; other model families would be harmed by adding them.
   */
  private decorate(text: string, role: 'passage' | 'query'): string {
    return /e5/i.test(this.model) ? `${role}: ${text}` : text;
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    await this.load();
    if (!this.extractor) throw new Error('임베더가 초기화되지 않았습니다.');

    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist().map((values) => Float32Array.from(values));
  }

  private load(): Promise<void> {
    // Guarded so concurrent jobs share one model load rather than racing.
    this.loading ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Keep model files inside the vault, next to the whisper assets.
      env.cacheDir = path.join(this.cacheDir, 'models');
      env.allowLocalModels = true;

      const extractor = await pipeline('feature-extraction', this.model, {
        dtype: 'q8',
        // The library's progress payload is a union of several shapes; only the
        // download fields matter here.
        progress_callback: this.onProgress
          ? (info: unknown) => {
              const progress = info as { file?: string; loaded?: number; total?: number };
              this.onProgress?.({
                file: progress.file ?? '',
                loaded: progress.loaded,
                total: progress.total,
              });
            }
          : undefined,
      });
      this.extractor = extractor as unknown as typeof this.extractor;
    })();

    return this.loading;
  }
}

/**
 * What actually gets embedded. The derived fields lead because they are the
 * densest description of the item; the body is truncated because the model has
 * a fixed context and a long transcript would drown the topic.
 */
export function embeddingText(item: Item, maxChars: number): string {
  const parts = [item.title, item.summary, item.tags.join(', '), item.body].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.join('\n').slice(0, maxChars);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors arrive normalised, so the dot product is already the cosine.
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}
