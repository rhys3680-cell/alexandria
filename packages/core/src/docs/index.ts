import path from 'node:path';
import { readPptx } from './pptx.js';

export * from './pptx.js';
export * from './zip.js';

export interface ExtractedDocument {
  text: string;
  /** One line for the log and the CLI, in the vault's language. */
  note: string;
}

/**
 * Turns a document into the markdown that becomes an item's body.
 *
 * Only formats that need no dependency belong here. PDF is the obvious next
 * one and is deliberately absent: Korean PDFs embed subset fonts with custom
 * encodings, so their glyphs mean nothing without the `ToUnicode` table, and
 * reading that properly is a parser, not a regex.
 */
export function extractDocument(filePath: string): ExtractedDocument {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.pptx') {
    const deck = readPptx(filePath);
    if (!deck.text.trim()) throw new Error('슬라이드에서 글자를 찾지 못했습니다.');
    return { text: deck.text, note: `슬라이드 ${deck.slideCount}장 중 ${deck.textSlideCount}장에서 추출` };
  }

  throw new Error(`문서로 읽을 수 없는 형식입니다: ${extension || filePath}`);
}
