import fs from 'node:fs';
import path from 'node:path';

/**
 * whisper.cpp caps the initial prompt at n_text_ctx/2 tokens. Korean and
 * Japanese cost well over one token per character, so this stays conservative;
 * terms past the limit are dropped rather than truncated mid-word.
 */
export const MAX_PROMPT_CHARS = 500;

export function dictionaryPath(vaultDir: string): string {
  // Deliberately at the vault root, not hidden inside .alexandria: this is a
  // file the user is meant to open and edit.
  return path.join(vaultDir, 'dictionary.txt');
}

export const DICTIONARY_HEADER = `# 자주 쓰는 이름과 용어를 한 줄에 하나씩 적으세요.
# 전사할 때 이 단어들 쪽으로 인식이 기울고, 정리할 때 잘못 들린 표기를 되돌립니다.
# '#' 로 시작하는 줄과 빈 줄은 무시합니다.
`;

export function loadDictionary(vaultDir: string): string[] {
  const file = dictionaryPath(vaultDir);
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function saveDictionary(vaultDir: string, terms: string[]): void {
  const file = dictionaryPath(vaultDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${DICTIONARY_HEADER}${unique(terms).join('\n')}\n`, 'utf8');
}

export function addTerms(vaultDir: string, terms: string[]): string[] {
  const merged = unique([...loadDictionary(vaultDir), ...terms.map((term) => term.trim()).filter(Boolean)]);
  saveDictionary(vaultDir, merged);
  return merged;
}

export function removeTerms(vaultDir: string, terms: string[]): string[] {
  const drop = new Set(terms.map((term) => term.trim().toLowerCase()));
  const kept = loadDictionary(vaultDir).filter((term) => !drop.has(term.toLowerCase()));
  saveDictionary(vaultDir, kept);
  return kept;
}

/**
 * The initial prompt handed to whisper.
 *
 * Measured on a 20-second Korean memo: with the terms present, the `base` model
 * went from six errors to one and `small` from two to zero — including the
 * speaker's name, which is the error that does the most damage downstream.
 */
export function buildWhisperPrompt(terms: string[], maxChars = MAX_PROMPT_CHARS): string {
  const selected: string[] = [];
  let length = 0;

  for (const term of unique(terms)) {
    const cost = term.length + 2;
    if (length + cost > maxChars) break;
    selected.push(term);
    length += cost;
  }
  return selected.join(', ');
}

function unique(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}
