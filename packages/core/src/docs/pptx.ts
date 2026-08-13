import fs from 'node:fs';
import { readZip, type ZipEntries } from './zip.js';

/**
 * Pulls the words out of a PowerPoint file.
 *
 * A `.pptx` is a zip of XML, and every visible string — titles, bullets, table
 * cells, chart labels — is an `<a:t>` run. Speaker notes live in their own
 * parts and are kept: a deck's argument is often written there in full while
 * the slide itself carries five words and a picture.
 */
export interface PptxDocument {
  /** Every slide, including ones that turned out to hold no text. */
  slideCount: number;
  /** Slides that contributed something. */
  textSlideCount: number;
  /** Markdown, in slide order. */
  text: string;
}

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_PART = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
const NOTES_RELS = /^ppt\/notesSlides\/_rels\/notesSlide(\d+)\.xml\.rels$/;

/** A title is a title when it is short enough to be one. */
const TITLE_MAX_CHARS = 80;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return NAMED_ENTITIES[code] ?? whole;
  });
}

/**
 * The text of one DrawingML part, one line per paragraph.
 *
 * Fields are dropped first. `<a:fld>` is how PowerPoint stores an automatic
 * slide number or date, and its cached value is a run like any other — left in,
 * every set of notes would begin with its own page number.
 */
function paragraphsOf(xml: string): string[] {
  const withoutFields = xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, '');
  const lines: string[] = [];

  for (const paragraph of withoutFields.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = '';
    for (const piece of (paragraph[1] ?? '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g)) {
      // Runs inside a paragraph are split by formatting, not by meaning, so
      // they join with nothing between them. An explicit break is a newline.
      line += piece[1] === undefined ? '\n' : decodeXml(piece[1]);
    }
    for (const part of line.split('\n')) {
      const trimmed = part.trim();
      if (trimmed) lines.push(trimmed);
    }
  }

  return lines;
}

function numberOf(name: string, pattern: RegExp): number {
  return Number.parseInt(name.match(pattern)?.[1] ?? '0', 10);
}

/**
 * Which slide each notes part belongs to.
 *
 * `notesSlide3.xml` is not the notes for slide 3 — the parts are numbered in
 * creation order, so a reordered or partly annotated deck breaks that guess.
 * The relationship file is the only thing that actually says.
 */
function notesBySlide(entries: ZipEntries): Map<number, string> {
  const bySlide = new Map<number, string>();

  for (const [name, read] of entries) {
    if (!NOTES_RELS.test(name)) continue;
    const notesNumber = numberOf(name, NOTES_RELS);
    const target = read().toString('utf8').match(/Target="[^"]*slides\/slide(\d+)\.xml"/);
    if (!target?.[1]) continue;

    const part = `ppt/notesSlides/notesSlide${notesNumber}.xml`;
    const body = entries.get(part);
    if (!body) continue;

    const lines = paragraphsOf(body().toString('utf8'));
    if (lines.length) bySlide.set(Number.parseInt(target[1], 10), lines.join('\n'));
  }

  // A deck whose notes carry no relationship files at all still has notes; fall
  // back to positional matching rather than dropping them.
  if (bySlide.size === 0) {
    for (const [name, read] of entries) {
      if (!NOTES_PART.test(name)) continue;
      const lines = paragraphsOf(read().toString('utf8'));
      if (lines.length) bySlide.set(numberOf(name, NOTES_PART), lines.join('\n'));
    }
  }

  return bySlide;
}

export function parsePptx(buffer: Buffer): PptxDocument {
  const entries = readZip(buffer);

  const slides = [...entries.keys()]
    .filter((name) => SLIDE_PART.test(name))
    // Numeric order, or slide10 lands between slide1 and slide2.
    .sort((a, b) => numberOf(a, SLIDE_PART) - numberOf(b, SLIDE_PART));

  if (slides.length === 0) throw new Error('슬라이드를 찾지 못했습니다.');

  const notes = notesBySlide(entries);
  const sections: string[] = [];

  for (const name of slides) {
    const lines = paragraphsOf(entries.get(name)!().toString('utf8'));
    const note = notes.get(numberOf(name, SLIDE_PART));
    if (lines.length === 0 && !note) continue;

    const block: string[] = [];
    const first = lines[0] ?? '';
    // Promote the opening line to a heading only when it reads like one. On a
    // text-heavy slide the first paragraph is a sentence, and a heading made of
    // it is worse than no heading.
    if (lines.length > 1 && first.length <= TITLE_MAX_CHARS) {
      block.push(`## ${first}`, '', ...lines.slice(1));
    } else if (lines.length) {
      block.push(...lines);
    }
    if (note) {
      if (block.length) block.push('');
      block.push(...note.split('\n').map((line) => `> ${line}`));
    }
    sections.push(block.join('\n'));
  }

  return {
    slideCount: slides.length,
    textSlideCount: sections.length,
    text: sections.join('\n\n'),
  };
}

export function readPptx(filePath: string): PptxDocument {
  return parsePptx(fs.readFileSync(filePath));
}
