import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  let value = now;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/**
 * ULID-shaped identifier: lexicographically sortable by creation time, which
 * lets us order items without touching the index.
 */
export function newId(at: Date = new Date()): string {
  return encodeTime(at.getTime()) + encodeRandom();
}

/** Short, human-facing suffix used in filenames. */
export function shortId(id: string): string {
  return id.slice(-6);
}
