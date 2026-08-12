import { z } from 'zod';

export const ITEM_KINDS = [
  'note',
  'meeting',
  'idea',
  'task',
  'log',
  'article',
  'reference',
  'other',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_SOURCES = ['manual', 'file', 'mic', 'watch', 'clipboard'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/**
 * raw          just captured, nothing derived yet
 * transcribing audio is being turned into text
 * transcribed  text exists, waiting to be organized
 * organizing   the LLM pass is running
 * organized    terminal success state
 * failed       terminal failure state; `error` explains why
 */
export const ITEM_STATUSES = [
  'raw',
  'transcribing',
  'transcribed',
  'organizing',
  'organized',
  'failed',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface ItemTask {
  text: string;
  /** ISO date (`YYYY-MM-DD`), resolved against the capture time. */
  due?: string;
  owner?: string;
  /** Set by the user, never by the model. */
  done?: boolean;
  doneAt?: string;
}

/** A single captured thing. Frontmatter of the markdown file is this, minus `body`. */
export interface Item {
  id: string;
  schema: number;
  created: string;
  updated: string;
  source: ItemSource;
  sourceRef?: string;
  status: ItemStatus;

  /** Primary language of the content, as a BCP-47 subtag (`ko`, `en`, `ja`...). */
  lang?: string;
  kind?: ItemKind;
  title?: string;
  summary?: string;
  tags: string[];
  /** English keywords, so a Korean note is still findable by an English query. */
  keywords: string[];
  people: string[];
  tasks: ItemTask[];
  highlights: string[];

  /** Vault-relative path of the source audio, when the item came from speech. */
  media?: string;
  durationMs?: number;

  organizedAt?: string;
  model?: string;
  /** Cumulative API-equivalent cost of organizing this item, in USD. */
  costUsd?: number;
  error?: string;

  /** Markdown body: the original text, or the transcript for audio items. */
  body: string;
  /** Vault-relative path of the markdown file backing this item. */
  path: string;
}

export const ORGANIZE_RESULT_SCHEMA = z.object({
  lang: z.string().min(2).max(12).default('und'),
  kind: z.enum(ITEM_KINDS).catch('note'),
  title: z.string().min(1).max(200),
  summary: z.string().default(''),
  tags: z.array(z.string().min(1)).max(12).default([]),
  keywords: z.array(z.string().min(1)).max(12).default([]),
  people: z.array(z.string().min(1)).max(20).default([]),
  tasks: z
    .array(
      z.object({
        text: z.string().min(1),
        due: z.string().optional(),
        owner: z.string().optional(),
      }),
    )
    .max(20)
    .default([]),
  highlights: z.array(z.string().min(1)).max(10).default([]),
});

export type OrganizeResult = z.infer<typeof ORGANIZE_RESULT_SCHEMA>;

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments: TranscriptSegment[];
}
