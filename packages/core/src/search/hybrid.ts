import type { StoredEmbedding } from '../store.js';
import { cosine } from './embedder.js';

export interface Scored {
  id: string;
  score: number;
}

/**
 * Brute force over every stored vector.
 *
 * At personal scale this is the right call: 10k items x 384 dims is a few
 * million multiplications, i.e. single-digit milliseconds, and it avoids
 * an approximate-nearest-neighbour index that would need its own upkeep.
 */
export function rankBySimilarity(
  embeddings: StoredEmbedding[],
  query: Float32Array,
  limit: number,
): Scored[] {
  return embeddings
    .map((entry) => ({ id: entry.id, score: cosine(query, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const RRF_K = 60;

/**
 * Reciprocal rank fusion of several ranked id lists.
 *
 * Fuses by position rather than by score on purpose. Lexical bm25 and cosine
 * similarity are not on comparable scales, and this embedding model in
 * particular packs everything into a narrow band — 0.825 for a direct hit
 * versus 0.790 for an unrelated note — so blending raw scores would let noise
 * outvote a genuine match. Ranks have none of that problem.
 */
export function fuseRanks(lists: string[][], k = RRF_K): Scored[] {
  const totals = new Map<string, number>();

  for (const list of lists) {
    list.forEach((id, index) => {
      totals.set(id, (totals.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }

  return [...totals.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
