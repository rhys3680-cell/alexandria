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

/** How many standard deviations above an item's own baseline counts as related. */
export const NEIGHBOUR_Z = 1.5;

/** Below this many candidates the baseline is not meaningful. */
export const MIN_BASELINE = 5;

/**
 * Neighbours that genuinely stand out, rather than the top N of everything.
 *
 * An absolute cosine cut-off cannot work here. Measured across five mutually
 * unrelated notes, every pair scored between 0.739 and 0.815 — the embedding
 * space is anisotropic, so nothing is ever far from anything. Mean-centering
 * widened the spread but did not fix the ordering, because there was no signal
 * to recover: the honest answer for an unrelated corpus is "nothing related".
 *
 * So the test is relative to each item's own distribution. A note is related
 * only if it sits well above how similar this item is to the vault in general,
 * which self-calibrates to any model and returns nothing when nothing fits.
 */
export function significantNeighbours(
  candidates: StoredEmbedding[],
  vector: Float32Array,
  limit: number,
  z = NEIGHBOUR_Z,
): Scored[] {
  if (candidates.length < MIN_BASELINE) return [];

  const scored = candidates.map((entry) => ({ id: entry.id, score: cosine(vector, entry.vector) }));
  const mean = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
  const variance = scored.reduce((sum, entry) => sum + (entry.score - mean) ** 2, 0) / scored.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return [];

  return scored
    .filter((entry) => entry.score >= mean + z * sd)
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
